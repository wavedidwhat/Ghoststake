// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Holds staked ERC-20 collateral and issues shares against it.
/// Deposit and withdraw only — no borrowing yet. Built on OpenZeppelin's
/// ERC4626 rather than hand-rolled share math: this *is* "ERC-20 in, share
/// accounting out," and ERC4626 already handles the inflation-attack and
/// rounding edge cases that a from-scratch implementation would need to
/// get right independently. `_decimalsOffset()` is set to add the standard
/// virtual-shares mitigation for first-depositor/donation attacks.
///
/// The debt check on withdraw is a stub: GHO-8 (borrow against collateral)
/// will wire `debtOf` to a real borrow ledger. Until then it always reads
/// zero, so withdrawals are never actually blocked.
contract CollateralVault is ERC4626, ReentrancyGuard {
    struct Position {
        uint256 principal;
        uint256 depositedAt;
    }

    /// @dev Per-user principal + last deposit timestamp. Share balances
    /// (via ERC20's own accounting) are the source of truth for redemption
    /// value; this is bookkeeping for anything that needs "how much did
    /// this user put in and when," e.g. the indexer or future yield logic.
    mapping(address => Position) public positions;

    /// @dev Stub for the future borrow ledger (GHO-8). Always zero today.
    mapping(address => uint256) public debtOf;

    event Deposited(address indexed user, uint256 assets, uint256 shares);
    event Withdrawn(address indexed user, uint256 assets, uint256 shares);

    error DebtOutstanding(address user, uint256 debt);

    constructor(IERC20 collateralAsset) ERC20("GhostStake Collateral Shares", "gsCOL") ERC4626(collateralAsset) { }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        super._deposit(caller, receiver, assets, shares);

        Position storage position = positions[receiver];
        position.principal += assets;
        position.depositedAt = block.timestamp;

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

        Position storage position = positions[owner];
        position.principal = assets >= position.principal ? 0 : position.principal - assets;

        emit Withdrawn(owner, assets, shares);
    }
}
