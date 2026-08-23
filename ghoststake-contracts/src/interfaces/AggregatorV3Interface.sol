// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Chainlink's standard price feed interface, vendored rather than
/// pulled in as a submodule.
///
/// The npm package `chainlink/contracts` is a large dependency for five
/// function signatures that have been ABI-stable for years and are implemented
/// identically by every aggregator proxy on every network we care about,
/// Robinhood Chain included. Vendoring keeps `forge install` to the two
/// submodules the repo already has.
///
/// Copied verbatim from Chainlink's `AggregatorV3Interface` — if it ever
/// diverges, this file is wrong and the upstream one is right.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function version() external view returns (uint256);

    function getRoundData(uint80 _roundId)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice The advisory pause flag Robinhood Chain's Stock Token feeds
/// expose while a corporate action is being processed.
///
/// Not part of `AggregatorV3Interface` and not present on crypto feeds, so
/// every call to it has to tolerate the function simply not existing.
interface IPausableOracle {
    function oraclePaused() external view returns (bool);
}
