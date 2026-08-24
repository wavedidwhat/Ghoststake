// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { CollateralVault } from "../../src/CollateralVault.sol";
import { ISettlementSink, ParimutuelRound } from "../../src/ParimutuelRound.sol";

/// @notice The router GHO-15 will actually need, in its most obvious form:
/// it borrows on a user's behalf, stakes the proceeds, and on settlement
/// repays the debt with whatever comes back.
///
/// `MockSettlementRouter` only records settlements, so it cannot show what
/// happens when the repayment itself fails. This one really calls
/// `vault.repay`, which is the whole point — GHO-16 exists to decide what
/// that call should do when the debt is already gone.
contract RepayingRouter is ISettlementSink {
    ParimutuelRound public immutable round;
    CollateralVault public immutable vault;
    IERC20 public immutable asset;

    mapping(address => uint256) public returnedToUser;

    constructor(ParimutuelRound round_, CollateralVault vault_, IERC20 asset_) {
        round = round_;
        vault = vault_;
        asset = asset_;
        asset_.approve(address(round_), type(uint256).max);
        asset_.approve(address(vault_), type(uint256).max);
    }

    function open(uint256 roundId, address user, ParimutuelRound.Side side, uint256 amount) external {
        round.takePositionFor(roundId, user, side, amount);
    }

    /// @dev The naive settlement: repay the debt, keep nothing.
    ///
    /// Deliberately unguarded, because the guard is the decision GHO-16 has
    /// to make. `vault.repay` reverts on a cleared lien, and a sink that
    /// reverts strands every payout it funded — see ADR 0013, finding 5.
    function onPositionSettled(address user, uint256 amount) external {
        vault.repay(amount, user);
    }
}

/// @notice The same router with the fix GHO-16 settles on: never revert, and
/// return anything the debt cannot absorb to the user.
contract SafeRepayingRouter is ISettlementSink {
    ParimutuelRound public immutable round;
    CollateralVault public immutable vault;
    IERC20 public immutable asset;

    mapping(address => uint256) public returnedToUser;
    mapping(address => uint256) public repaidForUser;

    constructor(ParimutuelRound round_, CollateralVault vault_, IERC20 asset_) {
        round = round_;
        vault = vault_;
        asset = asset_;
        asset_.approve(address(round_), type(uint256).max);
        asset_.approve(address(vault_), type(uint256).max);
    }

    function open(uint256 roundId, address user, ParimutuelRound.Side side, uint256 amount) external {
        round.takePositionFor(roundId, user, side, amount);
    }

    function onPositionSettled(address user, uint256 amount) external {
        uint256 owed = vault.lienOf(user);
        uint256 toRepay = amount < owed ? amount : owed;

        if (toRepay > 0) {
            vault.repay(toRepay, user);
            repaidForUser[user] += toRepay;
        }

        // Whatever the debt could not absorb belongs to the user. Holding it
        // here would strand their winnings inside the router.
        uint256 surplus = amount - toRepay;
        if (surplus > 0) {
            returnedToUser[user] += surplus;
            SafeERC20.safeTransfer(asset, user, surplus);
        }
    }
}
