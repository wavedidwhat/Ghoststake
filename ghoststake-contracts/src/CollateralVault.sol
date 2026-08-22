// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Holds staked ERC-20 collateral, issues shares against it, and
/// accrues yield on the side ledger lazily. Deposit and withdraw only — no
/// borrowing yet. Built on OpenZeppelin's ERC4626 rather than hand-rolled
/// share math: this *is* "ERC-20 in, share accounting out," and ERC4626
/// already handles the inflation-attack and rounding edge cases that a
/// from-scratch implementation would need to get right independently.
/// `_decimalsOffset()` is set to add the standard virtual-shares mitigation
/// for first-depositor/donation attacks.
///
/// Yield is never written on a timer or looped over users — it's derived
/// from elapsed time at call time (`accruedYield`) and only folded into
/// storage (`_settle`) on an actual state change: deposit, withdraw, or an
/// explicit `settle()` call. GHO-8/GHO-9 will call the same settle path
/// before mutating debt/liquidation state.
///
/// The debt check on withdraw is a stub: GHO-8 (borrow against collateral)
/// will wire `debtOf` to a real borrow ledger. Until then it always reads
/// zero, so withdrawals are never actually blocked.
contract CollateralVault is ERC4626, ReentrancyGuard {
    struct Position {
        uint256 principal;
        uint256 startTime;
        uint256 rate;
    }

    /// @dev WAD scale for `rate`: a per-second yield rate where 1e18 = 100%
    /// per second. Real rates are tiny — e.g. 5% APR is
    /// `0.05e18 / 365 days ≈ 1_585_489`.
    uint256 public constant RATE_PRECISION = 1e18;

    /// @dev Protocol-wide yield rate, set once at deployment. Stored again
    /// per-position (rather than read from here on every accrual calc) so
    /// a future version could let it vary per position without changing
    /// the accrual math — today every position's `rate` is always this
    /// value.
    uint256 public immutable yieldRatePerSecond;

    /// @dev Per-user principal (deposits, compounded with settled yield),
    /// accrual checkpoint, and rate. Share balances (via ERC20's own
    /// accounting) are the source of truth for what a user can redeem from
    /// the vault; this is a separate bookkeeping ledger — e.g. for the
    /// indexer, or a future health-factor calc that wants "collateral value
    /// including accrued interest."
    mapping(address => Position) public positions;

    /// @dev Stub for the future borrow ledger (GHO-8). Always zero today.
    mapping(address => uint256) public debtOf;

    event Deposited(address indexed user, uint256 assets, uint256 shares);
    event Withdrawn(address indexed user, uint256 assets, uint256 shares);
    event YieldSettled(address indexed user, uint256 yieldAccrued, uint256 newPrincipal);

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

    /// @notice Yield accrued since the position's last checkpoint, computed
    /// from elapsed time — never stored, never advanced by anything but the
    /// caller reading it.
    function accruedYield(address user) public view returns (uint256) {
        Position storage position = positions[user];
        uint256 elapsed = block.timestamp - position.startTime;
        if (elapsed == 0 || position.principal == 0) return 0;
        return (position.principal * position.rate * elapsed) / RATE_PRECISION;
    }

    /// @notice Folds accrued yield into principal and resets the accrual
    /// checkpoint. Safe to call anytime; a no-op past the first call in a
    /// block. Public so a keeper/indexer can checkpoint a position without
    /// needing to move funds, and so GHO-8/GHO-9 can settle before mutating
    /// debt or liquidating.
    function settle(address user) public {
        _settle(user);
    }

    function _settle(address user) internal {
        Position storage position = positions[user];
        uint256 yieldAccrued = accruedYield(user);
        if (yieldAccrued != 0) {
            position.principal += yieldAccrued;
        }
        if (position.startTime != block.timestamp) {
            position.startTime = block.timestamp;
        }
        if (position.rate != yieldRatePerSecond) {
            position.rate = yieldRatePerSecond;
        }
        if (yieldAccrued != 0) {
            emit YieldSettled(user, yieldAccrued, position.principal);
        }
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        super._deposit(caller, receiver, assets, shares);

        _settle(receiver);
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

        super._withdraw(caller, receiver, owner, assets, shares);

        _settle(owner);
        Position storage position = positions[owner];
        position.principal = assets >= position.principal ? 0 : position.principal - assets;

        emit Withdrawn(owner, assets, shares);
    }
}
