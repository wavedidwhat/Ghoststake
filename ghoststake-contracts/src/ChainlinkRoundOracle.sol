// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IRoundOracle } from "./ParimutuelRound.sol";
import { AggregatorV3Interface, IPausableOracle } from "./interfaces/AggregatorV3Interface.sol";

/// @notice Chainlink adapter for `ParimutuelRound`. Everything that can make
/// a price untrustworthy is decided here and reported as `ok == false`; the
/// round contract never learns what a heartbeat or a sequencer is.
///
/// # Why the adapter answers `ok` instead of reverting
///
/// A revert and an untrustworthy price are different events with different
/// correct responses. The round wants to *wait* through a hiccup and *void*
/// through an outage, and it can only tell those apart if the adapter keeps
/// answering. So every external call in here is wrapped: a feed that reverts
/// reads as unavailable, not as a failed transaction.
///
/// # The two reads
///
/// `readLatest()` — "the price now". Used for the strike, where there is no
/// later feed round to pin against yet.
///
/// `readAt(id, at)` — "the price at `at`", where the caller names the feed
/// round and this contract *verifies* the claim: that round must have been
/// published at or before `at`, and the very next one after `at`. Exactly one
/// feed round satisfies both, so the answer does not depend on who calls or
/// when. That is what stops a losing participant from resolving a round at a
/// moment of their choosing.
///
/// # What makes a reading untrustworthy
///
/// 1. **Staleness.** A price older than `maxStaleness` relative to the
///    instant being asked about. Set it to the feed's heartbeat plus a
///    buffer, read from Chainlink's network page — never guessed.
/// 2. **A non-positive answer.** Chainlink returns `int256`; zero or negative
///    on a USD feed means something is wrong, not that the asset is free.
/// 3. **L2 sequencer downtime.** On an L2, a down sequencer means nobody
///    could have transacted — including anyone who wanted to exit or
///    liquidate — so prices published around it must not settle anything.
///    Chainlink publishes a dedicated uptime feed for this, and it is checked
///    both for "up now" and for "was up at the instant in question".
/// 4. **A corporate-action pause.** Robinhood Chain's Stock Token feeds
///    expose `oraclePaused()` during corporate actions. Advisory only — a
///    paused oracle can still return a value and nothing enforces the flag
///    on-chain — so it is treated as a hint on top of staleness, which stays
///    the primary guard.
///
/// # Decimals are read, never assumed
///
/// `decimals()` is read from the feed at construction and every price is
/// scaled to 18. Most USD feeds are 8, but "most" is not "all", and a market
/// priced against a feed we assumed wrong about would settle on a number off
/// by ten orders of magnitude.
contract ChainlinkRoundOracle is IRoundOracle {
    uint8 public constant TARGET_DECIMALS = 18;

    AggregatorV3Interface public immutable feed;

    /// @dev Chainlink's L2 sequencer uptime feed. May be the zero address,
    /// which disables the check — correct on an L1 and in tests, wrong on
    /// Arbitrum or Robinhood Chain, where it is the whole point.
    AggregatorV3Interface public immutable sequencerUptimeFeed;

    /// @dev Oldest a price may be, relative to the instant being asked about.
    /// The feed's heartbeat plus a buffer.
    uint256 public immutable maxStaleness;

    /// @dev How long after the sequencer comes back before its prices are
    /// trusted again. Users need a window to react to what happened while
    /// they could not transact; settling inside it would settle against a
    /// market they were locked out of.
    uint256 public immutable sequencerGracePeriod;

    /// @dev Multiplier from feed decimals up to 18.
    uint256 private immutable scaleUp;

    error ZeroAddress();
    error UnsupportedDecimals(uint8 decimals);
    error InvalidParameters();

    constructor(
        AggregatorV3Interface feed_,
        AggregatorV3Interface sequencerUptimeFeed_,
        uint256 maxStaleness_,
        uint256 sequencerGracePeriod_
    ) {
        if (address(feed_) == address(0)) revert ZeroAddress();
        // A zero staleness bound would reject every price ever published,
        // which fails closed but fails always.
        if (maxStaleness_ == 0) revert InvalidParameters();

        uint8 feedDecimals = feed_.decimals();
        // Scaling down would throw away precision silently. No production
        // feed exceeds 18; refuse rather than guess what to do with one.
        if (feedDecimals > TARGET_DECIMALS) revert UnsupportedDecimals(feedDecimals);

        feed = feed_;
        sequencerUptimeFeed = sequencerUptimeFeed_;
        maxStaleness = maxStaleness_;
        sequencerGracePeriod = sequencerGracePeriod_;
        scaleUp = 10 ** uint256(TARGET_DECIMALS - feedDecimals);
    }

    // ------------------------------------------------------------------
    // IRoundOracle
    // ------------------------------------------------------------------

    /// @inheritdoc IRoundOracle
    function readLatest() external view returns (bool ok, uint256 price, uint80 oracleRoundId) {
        if (!_chainIsTrustworthyAt(block.timestamp)) return (false, 0, 0);

        (bool read, uint80 roundId, int256 answer, uint256 updatedAt) = _latestRound();
        if (!read || !_answerUsableAt(answer, updatedAt, block.timestamp)) return (false, 0, 0);

        return (true, uint256(answer) * scaleUp, roundId);
    }

    /// @inheritdoc IRoundOracle
    function readAt(uint80 oracleRoundId, uint256 at) external view returns (bool ok, uint256 price) {
        if (!_chainIsTrustworthyAt(at)) return (false, 0);

        (bool read, int256 answer, uint256 updatedAt) = _round(oracleRoundId);
        if (!read || !_answerUsableAt(answer, updatedAt, at)) return (false, 0);

        // The claim being verified: this is the *last* round published at or
        // before `at`. Its successor therefore has to exist and land strictly
        // after `at`. Without this half of the check the caller could name any
        // older round inside the staleness bound and pick their price from a
        // handful of candidates.
        //
        // A successor that does not exist yet is not a failure — it means the
        // feed has not published since `at`, so there is nothing to settle
        // against and the round should wait. Same answer, and the round knows
        // how long it is willing to wait.
        //
        // Note the one case this reads as unavailable without being: an
        // aggregator phase change, where the next round's id is not
        // `oracleRoundId + 1` at all (proxy round ids pack a phase into their
        // high bits). Rare, and it fails towards a refund.
        (bool readNext,, uint256 updatedAtNext) = _round(oracleRoundId + 1);
        if (!readNext || updatedAtNext <= at) return (false, 0);

        return (true, uint256(answer) * scaleUp);
    }

    // ------------------------------------------------------------------
    // Checks
    // ------------------------------------------------------------------

    /// @dev Whether prices around `at` can be trusted at all, before looking
    /// at any individual reading: was the chain itself working, and is the
    /// feed publishing rather than paused.
    function _chainIsTrustworthyAt(uint256 at) private view returns (bool) {
        return _sequencerUpAt(at) && !_feedPaused();
    }

    /// @dev Three conditions, not one. The sequencer must be up *now* (so the
    /// answer is current), it must have been up at `at` (so the price we are
    /// about to settle on was published to a working chain), and enough time
    /// must have passed since it came back for people to have acted on what
    /// they missed.
    function _sequencerUpAt(uint256 at) private view returns (bool) {
        if (address(sequencerUptimeFeed) == address(0)) return true;

        try sequencerUptimeFeed.latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            // 0 = up, 1 = down. `startedAt == 0` means the feed itself is
            // still initialising and says nothing yet.
            if (answer != 0 || startedAt == 0) return false;
            if (block.timestamp - startedAt <= sequencerGracePeriod) return false;
            // The current up-period must already have been running at `at`;
            // otherwise the sequencer was down then, whatever it is now.
            return startedAt <= at;
        } catch {
            return false;
        }
    }

    /// @dev Advisory. Stock Token feeds pause during corporate actions;
    /// crypto feeds have no such function, and a feed that does not implement
    /// it reverts here and reads as unpaused — which is correct, not a
    /// fallback.
    function _feedPaused() private view returns (bool) {
        try IPausableOracle(address(feed)).oraclePaused() returns (bool paused) {
            return paused;
        } catch {
            return false;
        }
    }

    function _answerUsableAt(int256 answer, uint256 updatedAt, uint256 at) private view returns (bool) {
        if (answer <= 0 || updatedAt == 0) return false;
        // A price published after the instant being asked about is not an
        // answer to the question, even though it is newer.
        if (updatedAt > at) return false;
        return at - updatedAt <= maxStaleness;
    }

    // ------------------------------------------------------------------
    // Wrapped feed reads
    // ------------------------------------------------------------------

    function _latestRound() private view returns (bool ok, uint80 roundId, int256 answer, uint256 updatedAt) {
        try feed.latestRoundData() returns (uint80 id, int256 answer_, uint256, uint256 updatedAt_, uint80) {
            return (true, id, answer_, updatedAt_);
        } catch {
            return (false, 0, 0, 0);
        }
    }

    function _round(uint80 roundId) private view returns (bool ok, int256 answer, uint256 updatedAt) {
        try feed.getRoundData(roundId) returns (uint80, int256 answer_, uint256, uint256 updatedAt_, uint80) {
            return (true, answer_, updatedAt_);
        } catch {
            return (false, 0, 0);
        }
    }
}
