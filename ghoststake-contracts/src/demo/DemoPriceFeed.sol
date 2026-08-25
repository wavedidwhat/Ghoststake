// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { AggregatorV3Interface } from "../interfaces/AggregatorV3Interface.sol";

/// @notice A Chainlink-shaped price feed whose rounds an operator publishes by
/// hand, so a demo round can resolve on cue instead of on a heartbeat.
///
/// # Why this exists
///
/// `ParimutuelRound` cannot settle until the feed publishes a round *after*
/// the round's close — that is the pinning rule that stops a loser choosing
/// their settlement price. Real feeds publish on a heartbeat measured in tens
/// of minutes (Sepolia ETH/USD) or on a 24/5 session (Robinhood Chain Stock
/// Tokens), so a five-minute round sits in Observation, unresolvable, for as
/// long as the feed feels like taking. Correct, and fatal to a live demo.
///
/// Shortening the round does not help: the floor on round length is the feed's
/// cadence, not ours. So the feed is what changes. A market backed by this
/// contract runs the same `ParimutuelRound`, the same `ChainlinkRoundOracle`,
/// and the same settlement path — the only difference is who publishes.
///
/// # This is not a mock
///
/// It is deployed to a real chain and money moves against it, so it behaves
/// like an aggregator rather than like a test double:
///
/// * **Round ids increase by one and never reuse.** History is kept, because
///   `readAt` reads a named past round and its successor.
/// * **Timestamps strictly increase.** Two rounds sharing a timestamp would
///   make "the last round at or before `at`" ambiguous, and the adapter would
///   then settle on whichever of them the caller named.
/// * **Non-positive answers are refused at the door.** The adapter rejects
///   them anyway, but a feed that accepted one would be publishing a price it
///   knows is unusable and calling the resulting stall a feed problem.
/// * **Publishing is owner-only.** On a public testnet an open `push` is an
///   open invitation to set the settlement price of a live round.
///
/// # It is still a feed nobody should trust
///
/// The price is whatever the operator says it is. That is the entire point,
/// and it is why `description()` says so in capitals: any surface rendering a
/// market's feed description must show a user, unmissably, that this market's
/// price is set by hand. The real-feed market stays the headline — the claim
/// worth making is that settlement is pinned to Chainlink, and that claim has
/// to be demonstrable on the real thing.
contract DemoPriceFeed is Ownable, AggregatorV3Interface {
    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 private immutable _decimals;
    string private _description;

    /// @dev Zero until the first push. `latestRoundData` reverts until then,
    /// exactly as an aggregator with no data does — and the adapter reads that
    /// as "unavailable", which is the truth.
    uint80 public latestRoundId;

    mapping(uint80 => Round) private _rounds;

    event AnswerPushed(uint80 indexed roundId, int256 answer, uint256 updatedAt);

    error NonPositiveAnswer(int256 answer);
    error TimestampNotAdvanced(uint256 last, uint256 pushed);
    error NoData();

    /// @param decimals_ Scale of the answers pushed here. Match the real feed
    /// the demo market is standing in for (8 for a Chainlink USD feed), so the
    /// two markets' strikes read as the same kind of number.
    /// @param assetLabel What this feed claims to price, e.g. "ETH / USD".
    constructor(uint8 decimals_, string memory assetLabel, address initialOwner) Ownable(initialOwner) {
        _decimals = decimals_;
        _description = string.concat("GHOSTSTAKE DEMO FEED (operator-set price) - ", assetLabel);
    }

    /// @notice Publish a price, timestamped now.
    ///
    /// One round per block at most: `block.timestamp` has to advance for the
    /// ordering guarantee to hold, and two answers in one block would produce
    /// two rounds a pinned read cannot choose between.
    function push(int256 answer) external onlyOwner returns (uint80 roundId) {
        return _push(answer, block.timestamp);
    }

    /// @notice Publish a price with an explicit timestamp.
    ///
    /// For rehearsing a settlement against a close that has already passed:
    /// the round needs a feed round published strictly after its `closeTime`,
    /// and on a chain with slow blocks `block.timestamp` may not be there yet.
    /// A timestamp in the future is allowed — the adapter refuses to read a
    /// price published after the instant it is asked about, so an operator who
    /// overshoots stalls their own demo rather than settling anything early.
    function pushAt(int256 answer, uint256 updatedAt) external onlyOwner returns (uint80 roundId) {
        return _push(answer, updatedAt);
    }

    function _push(int256 answer, uint256 updatedAt) private returns (uint80 roundId) {
        if (answer <= 0) revert NonPositiveAnswer(answer);

        uint256 last = _rounds[latestRoundId].updatedAt;
        if (updatedAt <= last) revert TimestampNotAdvanced(last, updatedAt);

        roundId = latestRoundId + 1;
        latestRoundId = roundId;
        _rounds[roundId] = Round(answer, updatedAt);

        emit AnswerPushed(roundId, answer, updatedAt);
    }

    // ------------------------------------------------------------------
    // AggregatorV3Interface
    // ------------------------------------------------------------------

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function version() external pure returns (uint256) {
        return 3;
    }

    /// @dev Reverts on a round that was never published, matching an
    /// aggregator's "No data present". The adapter wraps every read, so this
    /// reaches `ParimutuelRound` as "wait", never as a failed transaction.
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory round = _rounds[roundId];
        if (round.updatedAt == 0) revert NoData();
        return (roundId, round.answer, round.updatedAt, round.updatedAt, roundId);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint80 roundId = latestRoundId;
        Round memory round = _rounds[roundId];
        if (round.updatedAt == 0) revert NoData();
        return (roundId, round.answer, round.updatedAt, round.updatedAt, roundId);
    }
}
