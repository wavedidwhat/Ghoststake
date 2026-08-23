// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IRoundOracle } from "../../src/ParimutuelRound.sol";

/// @notice Stand-in for the Chainlink adapter GHO-14 will build. It exposes
/// exactly what `IRoundOracle` promises and nothing more, so tests exercise
/// the round's decisions rather than a feed's internals: `ok` folds together
/// staleness, sequencer downtime and pauses, and `oracleRoundId` is moved by
/// hand so ordering can be tested directly.
contract MockRoundOracle is IRoundOracle {
    bool public ok = true;
    uint256 public price;
    uint80 public oracleRoundId = 1;

    constructor(uint256 initialPrice) {
        price = initialPrice;
    }

    function readPrice() external view returns (bool, uint256, uint80) {
        return (ok, price, oracleRoundId);
    }

    /// @dev A real feed can only change price by advancing its round, so the
    /// mock does both together unless a test deliberately separates them.
    function setPrice(uint256 newPrice) external {
        price = newPrice;
        oracleRoundId += 1;
    }

    function setPriceWithoutAdvancing(uint256 newPrice) external {
        price = newPrice;
    }

    function setOk(bool value) external {
        ok = value;
    }
}
