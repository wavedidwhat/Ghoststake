// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AggregatorV3Interface } from "../../src/interfaces/AggregatorV3Interface.sol";

/// @notice A Chainlink aggregator with a publication history you drive by
/// hand. `push` appends a round the way a real feed does — id up by one,
/// timestamp forward — so tests can build the exact publication pattern a
/// pinned read has to pick from.
contract MockAggregatorV3 is AggregatorV3Interface {
    struct RoundData {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
        bool exists;
    }

    uint8 private immutable _decimals;
    uint80 public latestRoundId;
    mapping(uint80 => RoundData) private _roundData;

    /// @dev When true, every read reverts — a feed that is not merely stale
    /// but broken, which the adapter has to survive rather than propagate.
    bool public reverting;

    constructor(uint8 decimals_) {
        _decimals = decimals_;
    }

    function push(int256 answer, uint256 updatedAt) external returns (uint80) {
        latestRoundId += 1;
        _roundData[latestRoundId] = RoundData(answer, updatedAt, updatedAt, true);
        return latestRoundId;
    }

    /// @dev Jump the id forward without publishing the rounds in between, to
    /// stand in for an aggregator phase change.
    function skipTo(uint80 roundId) external {
        latestRoundId = roundId;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external pure returns (string memory) {
        return "MockAggregatorV3";
    }

    function version() external pure returns (uint256) {
        return 3;
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverting, "feed down");
        RoundData memory data = _roundData[roundId];
        require(data.exists, "No data present");
        return (roundId, data.answer, data.startedAt, data.updatedAt, roundId);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverting, "feed down");
        RoundData memory data = _roundData[latestRoundId];
        require(data.exists, "No data present");
        return (latestRoundId, data.answer, data.startedAt, data.updatedAt, latestRoundId);
    }
}

/// @notice Chainlink's L2 sequencer uptime feed: answer 0 = up, 1 = down,
/// and `startedAt` is when the current status began.
contract MockSequencerUptimeFeed is AggregatorV3Interface {
    int256 public answer;
    uint256 public startedAt;
    bool public reverting;

    constructor(int256 answer_, uint256 startedAt_) {
        answer = answer_;
        startedAt = startedAt_;
    }

    function set(int256 answer_, uint256 startedAt_) external {
        answer = answer_;
        startedAt = startedAt_;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function decimals() external pure returns (uint8) {
        return 0;
    }

    function description() external pure returns (string memory) {
        return "MockSequencerUptimeFeed";
    }

    function version() external pure returns (uint256) {
        return 3;
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverting, "sequencer feed down");
        return (roundId, answer, startedAt, startedAt, roundId);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverting, "sequencer feed down");
        return (1, answer, startedAt, startedAt, 1);
    }
}

/// @notice A feed that also exposes Robinhood Chain's advisory
/// `oraclePaused()` flag, as the Stock Token feeds do.
contract MockPausableAggregatorV3 is MockAggregatorV3 {
    bool public oraclePaused;

    constructor(uint8 decimals_) MockAggregatorV3(decimals_) { }

    function setPaused(bool value) external {
        oraclePaused = value;
    }
}
