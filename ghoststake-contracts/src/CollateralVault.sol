// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The creditor a position's lien is owed to. Kept as a narrow
/// interface rather than importing BorrowLiquidityPool directly, so the
/// vault stays decoupled from any particular lending implementation.
interface ILienSource {
    function balanceOfDebt(address user) external view returns (uint256);
    function borrow(uint256 amount, address onBehalfOf) external;
    function repay(uint256 amount, address onBehalfOf) external;
    function accrue() external;
}

/// @notice Holds staked ERC-20 collateral, issues shares against it, and
/// accrues yield on a side ledger lazily. Borrowing itself lives elsewhere;
/// this contract knows only that a position may carry a lien, and settles
/// that lien when the position exits.
///
/// Built on OpenZeppelin's ERC4626 rather than hand-rolled share math: this
/// *is* "ERC-20 in, share accounting out," and ERC4626 already handles the
/// inflation-attack and rounding edge cases a from-scratch implementation
/// would need to get right independently. `_decimalsOffset()` adds the
/// standard virtual-shares mitigation for first-depositor/donation attacks.
///
/// # The ledger invariant
///
/// `positions[user]` is a side ledger, but it is NOT independent of share
/// balances — it must stay strictly proportional to them:
///
///   balanceOf(user) == 0  <=>  positions[user] is empty
///
/// Every path that moves shares moves the ledger with them, pro-rata:
/// deposit, withdraw/redeem, AND plain ERC-20 transfers (see `_update`).
/// Without that, shares and ledger fork — a user could hand off their
/// shares, exit, and keep a phantom position that accrues forever, minting
/// unlimited collateral records from fixed capital.
///
/// # Yield accrual
///
/// Yield is never written on a timer or looped over users: it's derived
/// from elapsed time at call time (`accruedYield`) and only banked into
/// storage (`_settle`) on an actual state change — deposit, withdraw,
/// transfer, or an explicit `settle()`.
///
/// Accrual is deliberately PATH-INDEPENDENT. `principal` is the deposit
/// basis and never absorbs yield; banked yield lands in `settledYield`,
/// which does not itself earn. Folding yield back into the earning base
/// would make total yield a function of how often `settle()` was called,
/// and since `settle()` is free and permissionless anyone could grind extra
/// value out of it. Yield here is a pure function of (stake x time).
///
/// # Yield is NOT backed by assets
///
/// Nothing funds this yield. `totalAssets()` is the vault's real token
/// balance, and no rewards ever flow in, so `settledYield` is a claim
/// against assets that do not exist. Consumers MUST therefore use
/// `collateralValue()`, which caps ledger value at what the vault could
/// actually pay for the user's shares — never raw `principal` or
/// `totalLedgerValue`. GHO-8's health factor depends on this: lending
/// against uncapped ledger value would be lending against nothing.
contract CollateralVault is ERC4626, ReentrancyGuard {
    struct Position {
        /// @dev Deposit basis. Earns yield; never absorbs it.
        uint256 principal;
        /// @dev Accrual checkpoint — last time yield was banked.
        uint256 startTime;
        /// @dev Per-second WAD rate in force for this position.
        uint256 rate;
        /// @dev Yield banked at past checkpoints. Does not itself earn.
        uint256 settledYield;
    }

    /// @dev Shared fixed-point scale. 1e18 = 100%, for rates and ratios alike.
    uint256 public constant WAD = 1e18;

    /// @dev Alias kept for the accrual maths, where "rate precision" reads
    /// more clearly than a bare WAD.
    uint256 public constant RATE_PRECISION = WAD;

    /// @notice Risk parameters, grouped so they cannot be transposed at
    /// deployment. Four adjacent WAD ratios as positional arguments is a
    /// silent-swap waiting to happen.
    struct RiskParams {
        /// @dev Most you may borrow against a position, as a fraction of its
        /// collateral value. Deliberately well below `liquidationThreshold`;
        /// the gap is the buffer a borrower has before becoming liquidatable.
        uint256 maxLTV;
        /// @dev Debt-to-collateral ratio at which a position becomes
        /// liquidatable. Health factor is exactly 1 at this line.
        uint256 liquidationThreshold;
        /// @dev Discount a liquidator gets on seized collateral. Their whole
        /// incentive to show up.
        uint256 liquidationBonus;
        /// @dev Most of a lien that one liquidation may clear. Caps the
        /// damage a single dip does to a borrower.
        uint256 closeFactor;
        /// @dev Health factor below which `closeFactor` is lifted to 100%.
        /// See `_effectiveCloseFactor` for why this is not optional.
        uint256 fullLiquidationThreshold;
    }

    uint256 public immutable maxLTV;
    uint256 public immutable liquidationThreshold;
    uint256 public immutable liquidationBonus;
    uint256 public immutable closeFactor;
    uint256 public immutable fullLiquidationThreshold;

    /// @dev Protocol-wide yield rate, fixed at deployment. Copied onto each
    /// position on settle so a future version could vary it per position
    /// without changing the accrual math.
    uint256 public immutable yieldRatePerSecond;

    mapping(address => Position) public positions;

    /// @dev Where a position's lien is owed. Immutable and may be the zero
    /// address, which means no lending is wired up yet and every lien reads
    /// as zero — the state this contract shipped in before GHO-26.
    ILienSource public immutable lienSource;

    event Deposited(address indexed user, uint256 assets, uint256 shares);
    event Withdrawn(address indexed user, uint256 assets, uint256 shares);
    event YieldSettled(address indexed user, uint256 yieldAccrued, uint256 totalSettledYield);
    event PositionTransferred(address indexed from, address indexed to, uint256 principal, uint256 settledYield);
    event LienSettledAtExit(address indexed user, uint256 lienAmount, uint256 collateralReturned);
    event Borrowed(address indexed user, uint256 amount, uint256 lienAfter);
    event Repaid(address indexed payer, address indexed user, uint256 amount, uint256 lienAfter);
    event Liquidated(
        address indexed liquidator,
        address indexed user,
        uint256 debtRepaid,
        uint256 collateralSeized,
        uint256 bonusPaid,
        uint256 lienAfter,
        uint256 healthFactorAfter
    );

    error LienOutstanding(address user, uint256 lien);
    error PartialExitWithLienOpen(uint256 sharesRequested, uint256 sharesHeld);
    error CollateralBelowLien(address user, uint256 collateral, uint256 lien);
    error NoLienSource();
    error ExceedsMaxLTV(address user, uint256 requestedDebt, uint256 maxDebt);
    error NothingToRepay(address user);
    error PositionNotLiquidatable(address user, uint256 healthFactor);
    error ExceedsCloseFactor(uint256 requested, uint256 maxRepayable);
    error InvalidRiskParameters();
    error ZeroAmount();

    constructor(IERC20 collateralAsset, uint256 yieldRatePerSecond_, ILienSource lienSource_, RiskParams memory risk)
        ERC20("GhostStake Collateral Shares", "gsCOL")
        ERC4626(collateralAsset)
    {
        // Ordering matters as much as the values: originating above the
        // liquidation line would mean a borrow is liquidatable the moment it
        // opens, and a close factor of zero would make liquidation a no-op.
        if (risk.maxLTV >= risk.liquidationThreshold || risk.liquidationThreshold >= WAD) {
            revert InvalidRiskParameters();
        }
        if (risk.closeFactor == 0 || risk.closeFactor > WAD || risk.liquidationBonus >= WAD) {
            revert InvalidRiskParameters();
        }
        if (risk.fullLiquidationThreshold == 0 || risk.fullLiquidationThreshold > WAD) {
            revert InvalidRiskParameters();
        }

        yieldRatePerSecond = yieldRatePerSecond_;
        lienSource = lienSource_;
        maxLTV = risk.maxLTV;
        liquidationThreshold = risk.liquidationThreshold;
        liquidationBonus = risk.liquidationBonus;
        closeFactor = risk.closeFactor;
        fullLiquidationThreshold = risk.fullLiquidationThreshold;
    }

    /// @notice What this position owes: principal plus accrued interest, as
    /// tracked by the creditor. Read through rather than mirrored locally —
    /// two ledgers for one debt is the desync bug the security review found,
    /// and there is no reason to reintroduce its shape here.
    function lienOf(address user) public view returns (uint256) {
        if (address(lienSource) == address(0)) return 0;
        return lienSource.balanceOfDebt(user);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Yield accrued since this position's last checkpoint, derived
    /// from elapsed time. Never stored by this call — it's a pure read.
    function accruedYield(address user) public view returns (uint256) {
        Position storage position = positions[user];
        uint256 elapsed = block.timestamp - position.startTime;
        if (elapsed == 0 || position.principal == 0) return 0;
        return (position.principal * position.rate * elapsed) / RATE_PRECISION;
    }

    /// @notice Everything the ledger says this user is owed: deposit basis
    /// plus banked yield plus yield pending since the last checkpoint.
    /// @dev NOT backed by real assets — see the note on `collateralValue`.
    function totalLedgerValue(address user) public view returns (uint256) {
        Position storage position = positions[user];
        return position.principal + position.settledYield + accruedYield(user);
    }

    /// @notice The safe number for anything that lends against this position.
    /// Ledger value capped at what the vault could actually pay out for the
    /// user's shares, so unfunded yield can never become phantom collateral.
    /// GHO-8's health factor must read THIS, not `positions().principal`.
    function collateralValue(address user) public view returns (uint256) {
        return Math.min(totalLedgerValue(user), convertToAssets(balanceOf(user)));
    }

    // ------------------------------------------------------------------
    // Borrowing
    // ------------------------------------------------------------------

    /// @notice How healthy a position is, WAD-scaled: 1e18 is exactly at the
    /// liquidation line, above is safe, below is liquidatable.
    ///
    ///   healthFactor = collateralValue x liquidationThreshold / lien
    ///
    /// A position with no lien cannot be liquidated, so it reads as maximally
    /// healthy rather than dividing by zero.
    function healthFactor(address user) public view returns (uint256) {
        uint256 lien = lienOf(user);
        if (lien == 0) return type(uint256).max;
        return Math.mulDiv(collateralValue(user), liquidationThreshold, lien);
    }

    /// @notice Additional amount this position may still draw. Zero once the
    /// existing lien has reached the LTV ceiling.
    function maxBorrowable(address user) public view returns (uint256) {
        uint256 ceiling = Math.mulDiv(collateralValue(user), maxLTV, WAD);
        uint256 lien = lienOf(user);
        return ceiling > lien ? ceiling - lien : 0;
    }

    /// @notice Draw against your collateral. The collateral stays deposited
    /// and keeps earning; the funds come from the shared pool.
    ///
    /// @dev The ceiling checked here is `maxLTV`, which is strictly tighter
    /// than the liquidation line — so a freshly-opened borrow always lands
    /// with a health factor comfortably above 1, never right on it. That gap
    /// is the whole point: originating at the liquidation threshold would
    /// mean one block of interest makes you liquidatable.
    function borrow(uint256 amount) external nonReentrant {
        if (address(lienSource) == address(0)) revert NoLienSource();
        if (amount == 0) revert ZeroAmount();

        // Bank yield first: it feeds collateralValue, so borrowing capacity
        // should reflect everything earned up to this instant.
        _settle(msg.sender);
        lienSource.accrue();

        uint256 newDebt = lienOf(msg.sender) + amount;
        uint256 maxDebt = Math.mulDiv(collateralValue(msg.sender), maxLTV, WAD);
        if (newDebt > maxDebt) revert ExceedsMaxLTV(msg.sender, newDebt, maxDebt);

        // The pool pays the module, which is this contract; forward it on.
        lienSource.borrow(amount, msg.sender);
        SafeERC20.safeTransfer(IERC20(asset()), msg.sender, amount);

        emit Borrowed(msg.sender, amount, newDebt);
    }

    /// @notice Repay someone's lien. Open to any payer — clearing another
    /// account's debt can only ever help them, and it is what a liquidator
    /// will need in GHO-9.
    function repay(uint256 amount, address onBehalfOf) external nonReentrant {
        if (address(lienSource) == address(0)) revert NoLienSource();
        if (amount == 0) revert ZeroAmount();

        lienSource.accrue();
        uint256 lien = lienOf(onBehalfOf);
        if (lien == 0) revert NothingToRepay(onBehalfOf);

        // Overpaying is a courtesy, not an error: cap at what is owed so a
        // repayer racing an accrual cannot lose the excess.
        if (amount > lien) amount = lien;

        IERC20 collateral = IERC20(asset());
        SafeERC20.safeTransferFrom(collateral, msg.sender, address(this), amount);
        SafeERC20.forceApprove(collateral, address(lienSource), amount);
        lienSource.repay(amount, onBehalfOf);

        emit Repaid(msg.sender, onBehalfOf, amount, lien - amount);
    }

    // ------------------------------------------------------------------
    // Liquidation
    // ------------------------------------------------------------------

    /// @notice Whether this position can be liquidated right now.
    function isLiquidatable(address user) public view returns (bool) {
        return healthFactor(user) < WAD;
    }

    /// @notice Most of this position's lien a single liquidation may clear.
    /// Zero when the position is healthy.
    function maxLiquidatableDebt(address user) public view returns (uint256) {
        uint256 hf = healthFactor(user);
        if (hf >= WAD) return 0;
        return Math.mulDiv(lienOf(user), _effectiveCloseFactor(hf), WAD);
    }

    /// @dev The close factor, lifted to 100% once a position is far enough
    /// underwater.
    ///
    /// Seizing collateral at a bonus removes proportionally *more* collateral
    /// than debt. That is fine while collateral still exceeds
    /// `(1 + bonus) x debt` — the position ends up healthier. Below that line
    /// the arithmetic inverts and each partial liquidation leaves the position
    /// **less** healthy than it started, so capped liquidations spiral: every
    /// one makes the next worse while never being allowed to finish the job.
    ///
    /// Lifting the cap lets a liquidator close the whole lien in a single
    /// step, which ends the position instead of degrading it repeatedly. Aave
    /// V3 does the same thing for the same reason. Where collateral cannot
    /// cover the full bonus, the remainder is bad debt — recognised once,
    /// rather than ground out over many transactions.
    function _effectiveCloseFactor(uint256 hf) internal view returns (uint256) {
        return hf < fullLiquidationThreshold ? WAD : closeFactor;
    }

    /// @notice Clear part of an underwater position's lien and take its
    /// collateral at a discount.
    ///
    /// @dev Open to any caller by design. A permissioned liquidator is a
    /// centralisation point and a single point of failure — if the whitelisted
    /// bot is down, underwater positions sit unliquidated and the loss lands
    /// on suppliers. Anyone being able to do it is what makes the mechanism
    /// reliable, and the bonus is what makes it worth doing.
    ///
    /// @param user The position to liquidate.
    /// @param repayAmount How much of the lien to clear. Capped at the close
    /// factor; pass `type(uint256).max` to clear the maximum allowed.
    function liquidate(address user, uint256 repayAmount) external nonReentrant {
        if (address(lienSource) == address(0)) revert NoLienSource();

        // Both sides must be current before anything is judged: yield feeds
        // collateral value, interest feeds the lien, and either one can be
        // what tipped this position over the line.
        _settle(user);
        lienSource.accrue();

        uint256 hf = healthFactor(user);
        if (hf >= WAD) revert PositionNotLiquidatable(user, hf);

        uint256 maxRepay = Math.mulDiv(lienOf(user), _effectiveCloseFactor(hf), WAD);
        if (repayAmount == type(uint256).max) repayAmount = maxRepay;
        if (repayAmount == 0) revert ZeroAmount();
        if (repayAmount > maxRepay) revert ExceedsCloseFactor(repayAmount, maxRepay);

        // Collateral and debt are the same asset here, so value converts 1:1
        // and no oracle is involved. A different collateral asset would need
        // a price feed at exactly this line.
        //
        // A position deep enough underwater cannot pay the full bonus. Seize
        // what exists rather than reverting: leaving it untouched helps
        // nobody, and the shortfall is bad debt that must be visible.
        uint256 seized =
            Math.min(repayAmount + Math.mulDiv(repayAmount, liquidationBonus, WAD), convertToAssets(balanceOf(user)));

        // Liquidator pays first, then is paid — nothing leaves before the
        // debt it is buying has actually been cleared.
        _pullAndRepay(msg.sender, user, repayAmount);
        _seizeCollateral(user, msg.sender, seized);

        emit Liquidated(
            msg.sender,
            user,
            repayAmount,
            seized,
            seized > repayAmount ? seized - repayAmount : 0,
            lienOf(user),
            healthFactor(user)
        );
    }

    /// @dev Takes `amount` from `payer` and clears that much of `user`'s lien.
    function _pullAndRepay(address payer, address user, uint256 amount) private {
        IERC20 collateral = IERC20(asset());
        SafeERC20.safeTransferFrom(collateral, payer, address(this), amount);
        SafeERC20.forceApprove(collateral, address(lienSource), amount);
        lienSource.repay(amount, user);
    }

    /// @dev Burns the shares backing `amount` of collateral and hands the
    /// assets to `recipient`, keeping the position ledger proportional.
    function _seizeCollateral(address user, address recipient, uint256 amount) private {
        uint256 sharesBefore = balanceOf(user);
        uint256 sharesToBurn = Math.min(previewWithdraw(amount), sharesBefore);

        _burn(user, sharesToBurn);
        _reducePositionProRata(user, sharesToBurn, sharesBefore);

        SafeERC20.safeTransfer(IERC20(asset()), recipient, amount);
    }

    // ------------------------------------------------------------------
    // Accrual
    // ------------------------------------------------------------------

    /// @notice Banks accrued yield and resets the checkpoint. Free,
    /// permissionless, and value-neutral: because the earning base is never
    /// changed by settling, calling this more often cannot earn anyone more.
    /// Exposed so a keeper/indexer can checkpoint without moving funds, and
    /// so GHO-8/GHO-9 can settle before mutating debt or liquidating.
    function settle(address user) public {
        _settle(user);
    }

    function _settle(address user) internal {
        Position storage position = positions[user];
        uint256 yieldAccrued = accruedYield(user);

        if (yieldAccrued != 0) {
            position.settledYield += yieldAccrued;
        }
        if (position.startTime != block.timestamp) {
            position.startTime = block.timestamp;
        }
        if (position.rate != yieldRatePerSecond) {
            position.rate = yieldRatePerSecond;
        }
        if (yieldAccrued != 0) {
            emit YieldSettled(user, yieldAccrued, position.settledYield);
        }
    }

    /// @dev Removes `shares / totalShares` of a position. A full exit wipes
    /// it outright rather than subtracting, so no rounding dust can survive
    /// on an address that no longer holds shares.
    function _reducePositionProRata(address user, uint256 shares, uint256 totalShares) private {
        if (shares >= totalShares) {
            delete positions[user];
            return;
        }
        Position storage position = positions[user];
        position.principal -= Math.mulDiv(position.principal, shares, totalShares);
        position.settledYield -= Math.mulDiv(position.settledYield, shares, totalShares);
    }

    // ------------------------------------------------------------------
    // ERC4626 hooks
    // ------------------------------------------------------------------

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        _settle(receiver);
        super._deposit(caller, receiver, assets, shares);
        positions[receiver].principal += assets;

        emit Deposited(receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        // Bank yield earned on the full stake, and capture the share balance,
        // both before the burn changes either.
        _settle(owner);
        uint256 sharesBefore = balanceOf(owner);
        uint256 lien = lienOf(owner);

        if (lien != 0) {
            // Bring the creditor's index up to date before fixing the amount.
            // `repay` accrues on entry, so a figure read beforehand is already
            // stale by the time it lands and would leave a slice of interest
            // behind on an otherwise-closed position. Accruing first makes
            // that internal accrual a no-op and the settlement exact.
            lienSource.accrue();
            lien = lienOf(owner);
        }

        if (lien == 0) {
            super._withdraw(caller, receiver, owner, assets, shares);
            _reducePositionProRata(owner, shares, sharesBefore);
            emit Withdrawn(owner, assets, shares);
            return;
        }

        // A lien is open, so this is an exit, not a withdrawal: the protocol
        // takes what it is owed on the way out and the user keeps the rest.
        // Blocking instead (what this contract did before GHO-26) traps a
        // borrower in the position forever, which is strictly worse than a
        // haircut.
        if (shares != sharesBefore) revert PartialExitWithLienOpen(shares, sharesBefore);
        if (assets < lien) revert CollateralBelowLien(owner, assets, lien);

        // Inlined rather than delegated to `super._withdraw`, which would
        // send the whole amount to one address. Ordering follows OZ's: burn
        // before any transfer, so a reentrant asset token can only ever
        // observe a fully-settled position. `nonReentrant` covers it anyway.
        if (caller != owner) _spendAllowance(owner, caller, shares);
        _burn(owner, shares);
        _reducePositionProRata(owner, shares, sharesBefore);

        uint256 returned = assets - lien;
        IERC20 collateral = IERC20(asset());
        SafeERC20.forceApprove(collateral, address(lienSource), lien);
        lienSource.repay(lien, owner);
        if (returned != 0) SafeERC20.safeTransfer(collateral, receiver, returned);

        // `assets` is what left the vault against these shares; the split
        // between creditor and user is in LienSettledAtExit.
        emit Withdraw(caller, receiver, owner, assets, shares);
        emit LienSettledAtExit(owner, lien, returned);
        emit Withdrawn(owner, assets, shares);
    }

    /// @dev Shares are freely transferable, so the ledger has to travel with
    /// them or the two fork. Mint/burn legs are skipped — `_deposit` and
    /// `_withdraw` already own those. Not `nonReentrant`: this runs *inside*
    /// those already-guarded hooks on mint/burn, and a plain transfer makes
    /// no external calls.
    function _update(address from, address to, uint256 value) internal override {
        // `from == to` is a no-op economically, but would round-trip through
        // the delete branch below and wipe the checkpoint, so skip it.
        if (from != address(0) && to != address(0) && from != to && value != 0) {
            // Transfers stay blocked while a lien is open, deliberately
            // asymmetric with withdrawal. Exiting settles the lien from your
            // own collateral; handing shares to a clean address would move
            // the collateral away from the debt and leave the lien stranded
            // on an account with nothing behind it.
            uint256 lien = lienOf(from);
            if (lien != 0) revert LienOutstanding(from, lien);

            _settle(from);
            _settle(to);

            uint256 fromShares = balanceOf(from);
            // Let `super._update` raise ERC20InsufficientBalance rather than
            // dividing by zero here.
            if (fromShares == 0) {
                super._update(from, to, value);
                return;
            }

            Position storage source = positions[from];

            uint256 movedPrincipal = Math.mulDiv(source.principal, value, fromShares);
            uint256 movedYield = Math.mulDiv(source.settledYield, value, fromShares);

            if (value >= fromShares) {
                delete positions[from];
            } else {
                source.principal -= movedPrincipal;
                source.settledYield -= movedYield;
            }

            Position storage destination = positions[to];
            destination.principal += movedPrincipal;
            destination.settledYield += movedYield;

            emit PositionTransferred(from, to, movedPrincipal, movedYield);
        }

        super._update(from, to, value);
    }
}
