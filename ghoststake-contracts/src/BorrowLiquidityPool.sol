// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { Treasured } from "./Treasured.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { EntryPausable } from "./EntryPausable.sol";

/// @notice Shared lending liquidity for GhostStake. Suppliers deposit here,
/// borrowers draw against the pooled un-borrowed balance, and borrowers'
/// interest is what pays suppliers. Aave/Compound shaped.
///
/// # Why an index instead of a per-user rate
///
/// The borrow rate is a function of utilization, so it changes every time
/// anyone borrows or repays. That makes a per-user "rate snapshot at last
/// interaction" wrong: a user who last touched their position before a rate
/// change would have their whole elapsed window priced at a stale rate.
/// Fixing that by re-settling every user on every rate change means looping
/// over all users on every borrow, which does not fit in a block.
///
/// So balances are stored **scaled**: what's in storage is the balance
/// divided by the index at the time it was written. The live balance is
/// `scaled * currentIndex`. A rate change advances one number and every
/// position stays correct without being touched — O(1) forever, and exact
/// regardless of how often anyone interacts.
///
/// # Two indices
///
/// `borrowIndex` grows at the borrow rate, `supplyIndex` at the supply rate.
/// The gap between them is the reserve factor — the protocol's cut — which
/// is why they can't be one number.
///
///   utilization  U = borrowed / (available + borrowed)
///   borrowRate     = kinked curve of U (see `borrowRatePerSecond`)
///   supplyRate     = borrowRate * U * (1 - reserveFactor)
///
/// Supply rate carries the `* U` because only the borrowed fraction is
/// earning anything — idle liquidity pays nobody.
///
/// # Accrual is mildly path-dependent, and that is deliberate
///
/// Each accrual advances the index multiplicatively by `rate * elapsed`, so
/// accruing twice over two periods yields marginally more than once over
/// the whole span — the same shape as the `settle()` grind fixed in
/// CollateralVault (GHO-7). It is not fixed the same way here, for a reason
/// worth writing down.
///
/// In the vault, `settle(alice)` moved value to **alice alone**, so anyone
/// could grind it for private gain. `accrue()` moves the index for **every
/// supplier at once**. A supplier holding 1% of the pool pays 100% of the
/// gas to capture 1% of an effect bounded by `e^(rT) - (1+rT)` — about
/// 0.08%/year at a 4% rate. The economics are self-defeating, and every
/// mutating entry point already calls `accrue()` anyway, so the index is
/// advanced constantly by normal traffic rather than left for someone to
/// farm.
///
/// Removing it entirely would mean integrating a varying rate over time
/// without a cumulative product, which is what the index *is*. Aave and
/// Compound both live with the same residue. `test_accrueCadenceEffectIsNegligible`
/// pins the magnitude so a future change can't quietly widen it.
contract BorrowLiquidityPool is Treasured, ReentrancyGuard, EntryPausable {
    using SafeERC20 for IERC20;

    /// @dev Index precision. Higher than WAD because indices compound and
    /// precision loss here is permanent — it can never be recovered on a
    /// later accrual.
    uint256 public constant RAY = 1e27;

    /// @dev Rate and ratio precision. 1e18 = 100%.
    uint256 public constant WAD = 1e18;

    IERC20 public immutable asset;

    // --- interest rate curve, all per-second WAD rates ---

    /// @dev Rate at zero utilization.
    uint256 public immutable baseRatePerSecond;
    /// @dev Additional rate accrued linearly from 0 up to `kink`.
    uint256 public immutable slope1PerSecond;
    /// @dev Additional rate accrued linearly from `kink` up to 100%. Steep
    /// on purpose — past the kink, liquidity is scarce and the rate has to
    /// both deter new borrowing and pull supply in.
    uint256 public immutable slope2PerSecond;
    /// @dev Target utilization where the curve bends. WAD.
    uint256 public immutable kink;
    /// @dev Protocol's share of borrow interest. WAD.
    uint256 public immutable reserveFactor;

    // --- state ---

    uint256 public supplyIndex = RAY;
    uint256 public borrowIndex = RAY;
    uint256 public lastAccrualTime;

    uint256 public totalSupplyScaled;
    uint256 public totalBorrowScaled;
    /// @dev Protocol-owned. Held in the contract but never lendable and
    /// never withdrawable by suppliers.
    uint256 public totalReserves;

    /// @dev Cumulative debt written off as uncollectable, in asset units at
    /// the moment each write-off happened. A running total for reporting, not
    /// a balance: the loss it describes has already been taken out of
    /// `totalReserves` and out of `supplyIndex`.
    uint256 public totalBadDebt;

    /// @dev Loss that landed when there were no suppliers to absorb it.
    ///
    /// Separate from the socialised figure because it is a different fact. A
    /// write-down works by moving `supplyIndex`, which only means anything if
    /// somebody holds scaled supply against it. With an empty pool there is
    /// nobody to charge, and charging the *next* supplier would bill them for
    /// a loss that predates their deposit — they buy in at the current index,
    /// and the index is the only thing that remembers.
    uint256 public unsocialisedBadDebt;

    mapping(address => uint256) public scaledSupply;
    mapping(address => uint256) public scaledDebt;

    /// @dev The only address allowed to move debt. GHO-8's borrow logic.
    /// Debt has to be gated because this contract has no concept of
    /// collateral — it trusts the borrow module to have checked a health
    /// factor before drawing.
    address public borrowModule;

    event Supplied(address indexed user, uint256 amount, uint256 scaledAmount);
    event Withdrawn(address indexed user, uint256 amount, uint256 scaledAmount);
    event Borrowed(address indexed user, uint256 amount, uint256 scaledAmount);
    event Repaid(address indexed payer, address indexed user, uint256 amount, uint256 scaledAmount);
    event Accrued(uint256 supplyIndex, uint256 borrowIndex, uint256 reservesAdded);
    event BorrowModuleSet(address indexed module);
    event ReservesWithdrawn(address indexed to, uint256 amount);
    event BadDebtAbsorbed(
        address indexed user,
        uint256 loss,
        uint256 fromReserves,
        uint256 socialised,
        uint256 supplyIndexBefore,
        uint256 supplyIndexAfter
    );

    error ZeroAmount();
    error NotBorrowModule(address caller);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error InsufficientSupplyBalance(uint256 requested, uint256 balance);
    error RepayExceedsDebt(uint256 requested, uint256 debt);
    error InvalidCurve();
    error ZeroAddress();
    error BorrowModuleAlreadySet(address current);
    error ReservesSeniorToSuppliers(uint256 requested, uint256 withdrawable);
    error NoDebtToAbsorb(address user);

    modifier onlyBorrowModule() {
        if (msg.sender != borrowModule) revert NotBorrowModule(msg.sender);
        _;
    }

    constructor(
        IERC20 asset_,
        uint256 baseRatePerSecond_,
        uint256 slope1PerSecond_,
        uint256 slope2PerSecond_,
        uint256 kink_,
        uint256 reserveFactor_,
        address initialOwner,
        address pauseGuardian_
    ) Ownable(initialOwner) EntryPausable(pauseGuardian_) Treasured() {
        if (kink_ == 0 || kink_ >= WAD || reserveFactor_ >= WAD) revert InvalidCurve();

        asset = asset_;
        baseRatePerSecond = baseRatePerSecond_;
        slope1PerSecond = slope1PerSecond_;
        slope2PerSecond = slope2PerSecond_;
        kink = kink_;
        reserveFactor = reserveFactor_;
        lastAccrualTime = block.timestamp;
    }

    /// @notice Names the one contract allowed to create debt. **Set once.**
    ///
    /// @dev `borrowModule` is the only thing between this pool's liquidity and
    /// an uncollateralised draw — the pool has no concept of collateral and
    /// trusts the module entirely. A re-pointable setter therefore means a
    /// single compromised owner key can, in one transaction, aim it at their
    /// own contract and drain every un-borrowed deposit. Making it immutable
    /// after the first call removes that path completely, at the cost of
    /// needing a redeploy to change modules — the right trade for a setter
    /// with this much authority.
    function setBorrowModule(address module) external onlyOwner {
        if (module == address(0)) revert ZeroAddress();
        if (borrowModule != address(0)) revert BorrowModuleAlreadySet(borrowModule);
        borrowModule = module;
        emit BorrowModuleSet(module);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @dev Cash on hand, all of which is lendable and withdrawable.
    ///
    /// Reserves are deliberately NOT carved out here. They are credited when
    /// interest accrues into the index, not when a borrower pays, so carving
    /// them out would reduce what suppliers can withdraw on the strength of
    /// interest nobody has handed over. Reserves stay a bookkeeping figure
    /// until there is cash in excess of every supplier claim — see
    /// `withdrawReserves`.
    function availableLiquidity() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function totalSupplied() public view returns (uint256) {
        return Math.mulDiv(totalSupplyScaled, supplyIndex, RAY);
    }

    function totalBorrowed() public view returns (uint256) {
        return Math.mulDiv(totalBorrowScaled, borrowIndex, RAY);
    }

    function balanceOfSupply(address user) public view returns (uint256) {
        return Math.mulDiv(scaledSupply[user], supplyIndex, RAY);
    }

    function balanceOfDebt(address user) public view returns (uint256) {
        return Math.mulDiv(scaledDebt[user], borrowIndex, RAY);
    }

    /// @notice Fraction of the pool currently lent out. WAD.
    function utilization() public view returns (uint256) {
        uint256 borrowed = totalBorrowed();
        if (borrowed == 0) return 0;
        return Math.mulDiv(borrowed, WAD, availableLiquidity() + borrowed);
    }

    /// @notice The kinked curve. Shallow below `kink`, steep above.
    function borrowRatePerSecond() public view returns (uint256) {
        return _borrowRateAt(utilization());
    }

    function _borrowRateAt(uint256 u) internal view returns (uint256) {
        if (u <= kink) {
            return baseRatePerSecond + Math.mulDiv(slope1PerSecond, u, kink);
        }
        uint256 excess = u - kink;
        return baseRatePerSecond + slope1PerSecond + Math.mulDiv(slope2PerSecond, excess, WAD - kink);
    }

    /// @notice What suppliers earn. Borrow interest, scaled by how much of
    /// the pool is actually lent out, less the protocol's cut.
    function supplyRatePerSecond() public view returns (uint256) {
        return _supplyRateAt(utilization());
    }

    function _supplyRateAt(uint256 u) internal view returns (uint256) {
        uint256 borrowRate = _borrowRateAt(u);
        uint256 gross = Math.mulDiv(borrowRate, u, WAD);
        return Math.mulDiv(gross, WAD - reserveFactor, WAD);
    }

    // ------------------------------------------------------------------
    // Accrual
    // ------------------------------------------------------------------

    /// @notice Advances both indices to now. Permissionless and free to
    /// call; every state-changing entry point calls it first so no action
    /// is ever priced at a stale index.
    function accrue() public {
        uint256 elapsed = block.timestamp - lastAccrualTime;
        if (elapsed == 0) return;

        uint256 u = utilization();
        uint256 borrowGrowth = _borrowRateAt(u) * elapsed;
        uint256 supplyGrowth = _supplyRateAt(u) * elapsed;

        uint256 reservesAdded;
        if (borrowGrowth != 0) {
            // Reserve cut is taken from the interest borrowers actually owe
            // this period, so the books stay balanced against the index move.
            uint256 borrowInterest = Math.mulDiv(totalBorrowed(), borrowGrowth, WAD);
            reservesAdded = Math.mulDiv(borrowInterest, reserveFactor, WAD);
            totalReserves += reservesAdded;

            borrowIndex += Math.mulDiv(borrowIndex, borrowGrowth, WAD);
        }
        if (supplyGrowth != 0) {
            supplyIndex += Math.mulDiv(supplyIndex, supplyGrowth, WAD);
        }

        lastAccrualTime = block.timestamp;
        emit Accrued(supplyIndex, borrowIndex, reservesAdded);
    }

    // ------------------------------------------------------------------
    // Supply side
    // ------------------------------------------------------------------

    /// @dev An entry: this is new value arriving. `withdraw` below carries no
    /// guard and must never grow one — a pool that can stop you leaving is a
    /// different product from one that can stop you arriving.
    function supply(uint256 amount) external nonReentrant whenEntriesOpen {
        if (amount == 0) revert ZeroAmount();
        accrue();

        // Round scaled amount DOWN so a supplier can never scale up into
        // more than they paid for.
        uint256 scaled = Math.mulDiv(amount, RAY, supplyIndex);
        scaledSupply[msg.sender] += scaled;
        totalSupplyScaled += scaled;

        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Supplied(msg.sender, amount, scaled);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        accrue();

        uint256 balance = balanceOfSupply(msg.sender);
        if (amount > balance) revert InsufficientSupplyBalance(amount, balance);

        // The liquidity lock this protocol is structurally exposed to: your
        // funds may be out as someone else's loan. Named error so the UI can
        // say that plainly rather than surfacing a bare revert.
        uint256 available = availableLiquidity();
        if (amount > available) revert InsufficientLiquidity(amount, available);

        // Round the scaled burn UP so withdrawing can never leave a
        // free residue behind, and clear the position outright on a full
        // exit so rounding dust cannot survive.
        uint256 scaled = Math.mulDiv(amount, RAY, supplyIndex, Math.Rounding.Ceil);
        uint256 held = scaledSupply[msg.sender];
        if (scaled >= held) {
            scaled = held;
            scaledSupply[msg.sender] = 0;
        } else {
            scaledSupply[msg.sender] = held - scaled;
        }
        totalSupplyScaled -= scaled;

        asset.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, scaled);
    }

    // ------------------------------------------------------------------
    // Borrow side
    // ------------------------------------------------------------------

    /// @dev Gated: this contract does not know about collateral, so it
    /// trusts the borrow module to have checked a health factor first.
    /// @dev `nonReentrant` here is load-bearing in a non-obvious way, so do
    /// not remove it. `repay` zeroes `scaledDebt` *before* pulling tokens, so
    /// during that transfer a hooked asset hands control back with the debt
    /// already cleared. The vault's own guard is free at that point, so a
    /// borrow could be attempted against a position that momentarily reads as
    /// debt-free. This guard is what makes that inner call revert.
    /// @dev Guarded here as well as at the vault, and the redundancy is
    /// deliberate. `borrowModule` is set once and is the vault today, so this
    /// looks like a second lock on the same door — but the two contracts pause
    /// independently, and the pool is the one holding the liquidity. An
    /// operator halting the pool should not have to know which module happens
    /// to be pointed at it to be sure nothing new is drawn.
    function borrow(uint256 amount, address onBehalfOf) external nonReentrant onlyBorrowModule whenEntriesOpen {
        if (amount == 0) revert ZeroAmount();
        accrue();

        uint256 available = availableLiquidity();
        if (amount > available) revert InsufficientLiquidity(amount, available);

        // Round debt UP so a borrower can never round their obligation down.
        uint256 scaled = Math.mulDiv(amount, RAY, borrowIndex, Math.Rounding.Ceil);
        scaledDebt[onBehalfOf] += scaled;
        totalBorrowScaled += scaled;

        asset.safeTransfer(msg.sender, amount);
        emit Borrowed(onBehalfOf, amount, scaled);
    }

    /// @notice Repay someone's debt. Deliberately open to any caller — a
    /// third party repaying on your behalf can only ever help you, and
    /// liquidation (GHO-9) needs exactly this.
    function repay(uint256 amount, address onBehalfOf) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        accrue();

        uint256 debt = balanceOfDebt(onBehalfOf);
        if (amount > debt) revert RepayExceedsDebt(amount, debt);

        // Round the scaled reduction DOWN so repaying can never clear more
        // debt than was paid for; full repayment is handled exactly.
        uint256 scaled = Math.mulDiv(amount, RAY, borrowIndex);
        uint256 owed = scaledDebt[onBehalfOf];
        if (amount == debt || scaled >= owed) {
            scaled = owed;
            scaledDebt[onBehalfOf] = 0;
        } else {
            scaledDebt[onBehalfOf] = owed - scaled;
        }
        totalBorrowScaled -= scaled;

        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Repaid(msg.sender, onBehalfOf, amount, scaled);
    }

    // ------------------------------------------------------------------
    // Bad debt
    // ------------------------------------------------------------------

    /// @notice Write off a borrower's remaining debt as uncollectable, and
    /// charge the loss to reserves first and suppliers second.
    ///
    /// @dev Gated to the borrow module for the same reason `borrow` is, and it
    /// is the same trust. This contract has no concept of collateral, so it
    /// cannot tell an uncollectable loan from a perfectly good one — the
    /// module already decides what may be lent against what, and here it
    /// decides what can no longer be recovered. A public version of this
    /// function would be a permissionless "forgive my debt".
    ///
    /// The loss is measured here rather than passed in. The caller has already
    /// applied every asset it could seize; asking it to also state the
    /// remainder would put the pool's write-down at the mercy of the caller's
    /// arithmetic, and an overstated figure is an overstated haircut on every
    /// supplier at once.
    ///
    /// # Why the debt is cleared rather than left standing
    ///
    /// A written-off loan that stays in `totalBorrowScaled` keeps compounding
    /// interest nobody will pay, and — worse — keeps counting toward
    /// `utilization()`. Utilization sets the borrow rate for *everybody*, so a
    /// dead loan left on the books quietly taxes every honest borrower and
    /// pays the proceeds into an index backed by nothing. The write-off has to
    /// remove it from the supply of credit, not merely relabel it.
    ///
    /// # The order: reserves, then suppliers
    ///
    /// Reserves exist as the protocol's cut of borrower interest, and this is
    /// the risk that cut is being paid for. Charging suppliers while the
    /// treasury still held a balance would make the treasury senior to the
    /// people whose money was actually lent — the inversion `withdrawReserves`
    /// already refuses to allow on the cash side.
    ///
    /// @return loss The amount written off, in asset units.
    function absorbBadDebt(address user) external nonReentrant onlyBorrowModule returns (uint256 loss) {
        accrue();

        loss = balanceOfDebt(user);
        if (loss == 0) revert NoDebtToAbsorb(user);

        // Cleared before anything else, so the position stops accruing and
        // stops counting toward utilization from this instant.
        totalBorrowScaled -= scaledDebt[user];
        scaledDebt[user] = 0;

        uint256 fromReserves = Math.min(loss, totalReserves);
        totalReserves -= fromReserves;

        uint256 remainder = loss - fromReserves;
        uint256 indexBefore = supplyIndex;
        uint256 socialised;

        if (remainder != 0) {
            uint256 supplied = totalSupplied();
            if (supplied == 0) {
                // Nobody to charge. Recorded rather than dropped, and
                // deliberately NOT carried forward onto whoever supplies next:
                // a new supplier buys in at the current index, and billing
                // them for a loss that predates their deposit would be
                // charging them for someone else's loan.
                unsocialisedBadDebt += remainder;
            } else {
                socialised = Math.min(remainder, supplied);
                // Rounded down, so the index never lands above the value the
                // pool can actually stand behind. The dust falls on suppliers,
                // which is the only direction available — the pool has no
                // third party to absorb it.
                uint256 next = Math.mulDiv(supplyIndex, supplied - socialised, supplied);

                // The index may never reach zero, and this is not a rounding
                // nicety. `supply` divides by it to scale a deposit, so an
                // index of zero is not "suppliers lost everything" — it is a
                // pool that reverts on every future deposit, permanently, with
                // no way back. A total wipeout is reachable in principle: a
                // loss equal to everything suppliers hold takes the multiplier
                // to zero exactly.
                //
                // Floored at one, which leaves holders a dust rather than a
                // brick. The scaled amounts a near-zero index produces stay
                // well inside uint256 — `mulDiv` carries the intermediate
                // product at 512 bits — so the floor costs nothing but the
                // failure mode.
                supplyIndex = next == 0 ? 1 : next;

                // A loss larger than everything suppliers hold has nowhere
                // left to go.
                if (remainder > socialised) unsocialisedBadDebt += remainder - socialised;
            }
        }

        totalBadDebt += loss;
        emit BadDebtAbsorbed(user, loss, fromReserves, socialised, indexBefore, supplyIndex);
    }

    // ------------------------------------------------------------------
    // Reserves
    // ------------------------------------------------------------------

    /// @notice Draw protocol reserves. Subordinated to suppliers.
    ///
    /// @dev Reserves are credited at *accrual* time, not at receipt — the cut
    /// is taken the moment interest is added to `borrowIndex`, whether or not
    /// a borrower has paid anything. Without a floor here that makes the
    /// treasury a **senior, cash-settled claim on interest nobody has paid**:
    /// it could withdraw real tokens that are actually supplier principal,
    /// leaving suppliers unable to exit and absorbing the whole loss if those
    /// borrowers later default.
    ///
    /// The floor keeps enough cash to cover every supplier claim that is not
    /// currently lent out, so reserves can only ever be drawn from genuine
    /// surplus.
    ///
    /// The destination is `treasury`, not a parameter — see `Treasured`. That
    /// matters more here than for the rake: reserves are subordinated to
    /// suppliers by the floor below, and a claim that is both subordinated and
    /// payable to an address chosen at call time is a strange thing to ask
    /// anybody to supply against.
    function withdrawReserves(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > totalReserves) revert InsufficientSupplyBalance(amount, totalReserves);

        // Reserves are only real once there is cash left over after every
        // supplier claim could be met. Anything less and the "reserve" is
        // simply supplier principal wearing a different label: the cut was
        // credited when interest accrued into the index, and unpaid interest
        // is not cash. Measuring against `totalBorrowed` instead would let the
        // treasury draw against debt nobody has repaid, which is the same
        // error one level removed.
        uint256 supplied = totalSupplied();
        uint256 balance = asset.balanceOf(address(this));
        uint256 withdrawable = balance > supplied ? balance - supplied : 0;
        if (amount > withdrawable) revert ReservesSeniorToSuppliers(amount, withdrawable);

        address to = treasury;
        totalReserves -= amount;
        asset.safeTransfer(to, amount);
        emit ReservesWithdrawn(to, amount);
    }
}
