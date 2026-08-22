// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ISettlementSink, ParimutuelRound } from "../../src/ParimutuelRound.sol";

/// @notice Stand-in for GHO-15's borrow-to-position router: takes a position
/// on a user's behalf with funds it is holding for them, and receives the
/// proceeds back so they can be settled against the debt.
///
/// Real debt repayment is GHO-15's job. Here the sink only records what came
/// back and for whom, which is the part the round contract is responsible for
/// getting right.
contract MockSettlementRouter is ISettlementSink {
    ParimutuelRound public immutable round;
    IERC20 public immutable stakeAsset;

    mapping(address => uint256) public settledFor;
    uint256 public callCount;

    constructor(ParimutuelRound round_, IERC20 stakeAsset_) {
        round = round_;
        stakeAsset = stakeAsset_;
        stakeAsset_.approve(address(round_), type(uint256).max);
    }

    function open(uint256 roundId, address user, ParimutuelRound.Side side, uint256 amount) external {
        round.takePositionFor(roundId, user, side, amount);
    }

    function onPositionSettled(address user, uint256 amount) external {
        settledFor[user] += amount;
        callCount += 1;
    }
}
