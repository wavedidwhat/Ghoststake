// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Holds staked ERC-20 collateral, issues shares against it, and
/// accrues yield on a side ledger lazily. Deposit and withdraw only — no
/// borrowing yet.
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

    /// @dev WAD scale for `rate`: 1e18 = 100% per second. Real rates are
    /// tiny — 5% APR is `5e16 / 365 days ≈ 1_585_489`.
    uint256 public constant RATE_PRECISION = 1e18;

    /// @dev Protocol-wide yield rate, fixed at deployment. Copied onto each
    /// position on settle so a future version could vary it per position
    /// without changing the accrual math.
    uint256 public immutable yieldRatePerSecond;

    mapping(address => Position) public positions;

    /// @dev Stub for the future borrow ledger (GHO-8). Always zero today —
    /// there is deliberately no production setter.
    mapping(address => uint256) public debtOf;

    event Deposited(address indexed user, uint256 assets, uint256 shares);
    event Withdrawn(address indexed user, uint256 assets, uint256 shares);
    event YieldSettled(address indexed user, uint256 yieldAccrued, uint256 totalSettledYield);
    event PositionTransferred(address indexed from, address indexed to, uint256 principal, uint256 settledYield);

    error DebtOutstanding(address user, uint256 debt);

    constructor(IERC20 collateralAsset, uint256 yieldRatePerSecond_)
        ERC20("GhostStake Collateral Shares", "gsCOL")
        ERC4626(collateralAsset)
    {
        yieldRatePerSecond = yieldRatePerSecond_;
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
        uint256 debt = debtOf[owner];
        if (debt != 0) revert DebtOutstanding(owner, debt);

        // Bank yield earned on the full stake, and capture the share balance,
        // both before the burn changes either.
        _settle(owner);
        uint256 sharesBefore = balanceOf(owner);

        super._withdraw(caller, receiver, owner, assets, shares);

        _reducePositionProRata(owner, shares, sharesBefore);

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
            uint256 debt = debtOf[from];
            if (debt != 0) revert DebtOutstanding(from, debt);

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
