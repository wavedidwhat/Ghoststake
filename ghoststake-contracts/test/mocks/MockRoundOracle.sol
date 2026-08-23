// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IRoundOracle } from "../../src/ParimutuelRound.sol";

/// @notice A directly-controllable `IRoundOracle`, used by the round tests so
/// they exercise the round's *decisions* rather than a feed's internals: `ok`
/// folds together staleness, sequencer downtime and pauses, and feed rounds
/// are advanced by hand.
///
/// It deliberately does NOT reproduce `readAt`'s pinning rule — that rule is
/// the adapter's job and is tested against the real one in
/// `ChainlinkRoundOracle.t.sol` over a mock aggregator. Duplicating it here
/// would mean the round tests passing against a second implementation of the
/// thing under test.
contract MockRoundOracle is IRoundOracle {
    bool public ok = true;
    uint256 public price;
    uint80 public oracleRoundId = 1;

    mapping(uint80 => uint256) public priceOfRound;

    constructor(uint256 initialPrice) {
        price = initialPrice;
        priceOfRound[oracleRoundId] = initialPrice;
    }

    function readLatest() external view returns (bool, uint256, uint80) {
        return (ok, price, oracleRoundId);
    }

    function readAt(uint80 roundId, uint256) external view returns (bool, uint256) {
        uint256 recorded = priceOfRound[roundId];
        if (!ok || recorded == 0) return (false, 0);
        return (true, recorded);
    }

    /// @dev A real feed can only change price by publishing a new round, so
    /// the mock does both together unless a test deliberately separates them.
    function setPrice(uint256 newPrice) external {
        oracleRoundId += 1;
        price = newPrice;
        priceOfRound[oracleRoundId] = newPrice;
    }

    function setPriceWithoutAdvancing(uint256 newPrice) external {
        price = newPrice;
        priceOfRound[oracleRoundId] = newPrice;
    }

    function setOk(bool value) external {
        ok = value;
    }
}
