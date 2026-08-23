// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ChainlinkRoundOracle } from "../src/ChainlinkRoundOracle.sol";
import { AggregatorV3Interface } from "../src/interfaces/AggregatorV3Interface.sol";
import { MockAggregatorV3, MockSequencerUptimeFeed, MockPausableAggregatorV3 } from "./mocks/MockAggregatorV3.sol";

/// @notice GHO-14: the Chainlink adapter.
///
/// Two questions run through all of it. `readLatest` asks "is this price
/// trustworthy right now"; `readAt` asks the harder one, "is this the price
/// at that instant, and can the caller have chosen it".
contract ChainlinkRoundOracleTest is Test {
    uint256 internal constant BASE_TIME = 1_700_000_000;
    uint256 internal constant MAX_STALENESS = 1 hours;
    uint256 internal constant SEQUENCER_GRACE = 30 minutes;

    /// @dev 8 decimals, as most USD feeds are — and deliberately not 18, so
    /// every price assertion also checks the scaling.
    uint8 internal constant FEED_DECIMALS = 8;

    ChainlinkRoundOracle internal adapter;
    MockAggregatorV3 internal feed;
    MockSequencerUptimeFeed internal sequencer;

    function setUp() public {
        vm.warp(BASE_TIME);

        feed = new MockAggregatorV3(FEED_DECIMALS);
        // Sequencer up, and up since long before anything we test.
        sequencer = new MockSequencerUptimeFeed(0, BASE_TIME - 30 days);
        adapter = new ChainlinkRoundOracle(
            AggregatorV3Interface(address(feed)),
            AggregatorV3Interface(address(sequencer)),
            MAX_STALENESS,
            SEQUENCER_GRACE
        );
    }

    // ------------------------------------------------------------------
    // readLatest
    // ------------------------------------------------------------------

    function test_readLatestScalesFeedDecimalsToEighteen() public {
        feed.push(2000e8, BASE_TIME);

        (bool ok, uint256 price, uint80 roundId) = adapter.readLatest();
        assertTrue(ok);
        assertEq(price, 2000e18); // 8 decimals in, 18 out
        assertEq(roundId, 1);
    }

    function test_readLatestRejectsAPriceOlderThanTheHeartbeat() public {
        feed.push(2000e8, BASE_TIME - MAX_STALENESS - 1);

        (bool ok,,) = adapter.readLatest();
        assertFalse(ok);

        // Exactly at the bound is still good — the bound is inclusive.
        feed.push(2000e8, BASE_TIME - MAX_STALENESS);
        (ok,,) = adapter.readLatest();
        assertTrue(ok);
    }

    /// @dev Chainlink answers are `int256`. Zero or negative on a USD feed
    /// means the feed is broken, not that the asset became free.
    function test_readLatestRejectsNonPositiveAnswers() public {
        feed.push(0, BASE_TIME);
        (bool ok,,) = adapter.readLatest();
        assertFalse(ok);

        feed.push(-1, BASE_TIME);
        (ok,,) = adapter.readLatest();
        assertFalse(ok);
    }

    /// @dev The adapter must never propagate a revert. The round contract
    /// distinguishes "wait" from "void" by the `ok` flag, and it cannot do
    /// that if the call takes the whole transaction down with it.
    function test_abrokenFeedReadsAsUnavailableRatherThanReverting() public {
        feed.push(2000e8, BASE_TIME);
        feed.setReverting(true);

        (bool ok,,) = adapter.readLatest();
        assertFalse(ok);

        (bool okAt,) = adapter.readAt(1, BASE_TIME);
        assertFalse(okAt);
    }

    function test_emptyFeedReadsAsUnavailable() public view {
        (bool ok,,) = adapter.readLatest();
        assertFalse(ok);
    }

    // ------------------------------------------------------------------
    // readAt — the pinning rule
    // ------------------------------------------------------------------

    /// @dev Three publications around the instant we care about. Exactly one
    /// of them is "the price at 250": the one published at 200, because 300
    /// is the first publication after 250.
    function _threePublications() internal returns (uint80 before_, uint80 pinned, uint80 after_) {
        before_ = feed.push(2000e8, BASE_TIME + 100);
        pinned = feed.push(2100e8, BASE_TIME + 200);
        after_ = feed.push(1900e8, BASE_TIME + 300);
        vm.warp(BASE_TIME + 400);
    }

    function test_readAtReturnsTheLastPublicationAtOrBeforeTheInstant() public {
        (, uint80 pinned,) = _threePublications();

        (bool ok, uint256 price) = adapter.readAt(pinned, BASE_TIME + 250);
        assertTrue(ok);
        assertEq(price, 2100e18);
    }

    /// @dev The half of the check that removes caller discretion. Without the
    /// successor test, naming the *earlier* round would be accepted too, and
    /// the caller would be choosing between 2000 and 2100 — which is choosing
    /// the outcome.
    function test_readAtRejectsAnEarlierRoundThatIsNotTheLastOne() public {
        (uint80 before_,,) = _threePublications();

        (bool ok,) = adapter.readAt(before_, BASE_TIME + 250);
        assertFalse(ok);
    }

    function test_readAtRejectsARoundPublishedAfterTheInstant() public {
        (,, uint80 after_) = _threePublications();

        (bool ok,) = adapter.readAt(after_, BASE_TIME + 250);
        assertFalse(ok);
    }

    /// @dev Nothing published since the instant yet, so no round can be shown
    /// to be the last one before it. Not a failure — a "not yet", which the
    /// round contract waits out.
    function test_readAtIsUnavailableUntilTheFeedPublishesAgain() public {
        uint80 pinned = feed.push(2000e8, BASE_TIME + 100);
        vm.warp(BASE_TIME + 200);

        (bool ok,) = adapter.readAt(pinned, BASE_TIME + 150);
        assertFalse(ok);

        feed.push(2050e8, BASE_TIME + 250);
        (ok,) = adapter.readAt(pinned, BASE_TIME + 150);
        assertTrue(ok);
    }

    /// @dev Staleness for a historical read is measured against the instant
    /// being asked about, not against `block.timestamp` — otherwise every
    /// round would become unresolvable simply by being old.
    function test_readAtMeasuresStalenessAgainstTheInstantNotNow() public {
        uint80 pinned = feed.push(2000e8, BASE_TIME);
        feed.push(2010e8, BASE_TIME + 10);

        // Days later, the reading is still the right answer for BASE_TIME + 5.
        vm.warp(BASE_TIME + 30 days);
        (bool ok, uint256 price) = adapter.readAt(pinned, BASE_TIME + 5);
        assertTrue(ok);
        assertEq(price, 2000e18);
    }

    function test_readAtRejectsAGapLongerThanTheHeartbeat() public {
        uint80 pinned = feed.push(2000e8, BASE_TIME);
        uint256 at = BASE_TIME + MAX_STALENESS + 1;
        feed.push(2010e8, at + 1);
        vm.warp(at + 100);

        // The pinned round IS the last one before `at` — it is simply too old
        // to describe the price there. A gap that long means the feed went
        // quiet, and settling across it would be inventing a price.
        (bool ok,) = adapter.readAt(pinned, at);
        assertFalse(ok);
    }

    /// @dev Proxy round ids pack a phase into their high bits, so after a
    /// phase change the next round is not `id + 1`. The adapter cannot see
    /// the successor and reads as unavailable — which fails towards a refund.
    function test_readAtIsUnavailableAcrossAnAggregatorPhaseChange() public {
        uint80 pinned = feed.push(2000e8, BASE_TIME + 100);
        feed.skipTo(uint80(1 << 64));
        feed.push(2100e8, BASE_TIME + 300);
        vm.warp(BASE_TIME + 400);

        (bool ok,) = adapter.readAt(pinned, BASE_TIME + 200);
        assertFalse(ok);
    }

    // ------------------------------------------------------------------
    // L2 sequencer uptime
    // ------------------------------------------------------------------

    function test_sequencerDownMakesEveryReadUnavailable() public {
        feed.push(2000e8, BASE_TIME);
        sequencer.set(1, BASE_TIME - 1 days); // 1 = down

        (bool ok,,) = adapter.readLatest();
        assertFalse(ok);
    }

    /// @dev Coming back is not enough. Users who were locked out need a
    /// window to react before anything settles against a market they could
    /// not trade in.
    function test_sequencerInsideItsRecoveryGraceIsStillUntrusted() public {
        feed.push(2000e8, BASE_TIME);
        sequencer.set(0, BASE_TIME - SEQUENCER_GRACE); // just came back

        (bool ok,,) = adapter.readLatest();
        assertFalse(ok);

        // One second past the grace period and it is trusted again.
        sequencer.set(0, BASE_TIME - SEQUENCER_GRACE - 1);
        (ok,,) = adapter.readLatest();
        assertTrue(ok);
    }

    /// @dev A historical read has to ask whether the sequencer was up *then*,
    /// not only whether it is up now. If the current up-period began after
    /// the instant, the chain was down at that instant.
    function test_readAtRejectsAnInstantFromBeforeTheSequencerRecovered() public {
        uint80 pinned = feed.push(2000e8, BASE_TIME + 100);
        feed.push(2100e8, BASE_TIME + 300);
        vm.warp(BASE_TIME + 10 days);

        // Sequencer has been up since well after the instant in question.
        sequencer.set(0, BASE_TIME + 5 days);
        (bool ok,) = adapter.readAt(pinned, BASE_TIME + 200);
        assertFalse(ok);

        // Up since before it: fine.
        sequencer.set(0, BASE_TIME - 1 days);
        (ok,) = adapter.readAt(pinned, BASE_TIME + 200);
        assertTrue(ok);
    }

    function test_anUnreadableSequencerFeedFailsClosed() public {
        feed.push(2000e8, BASE_TIME);
        sequencer.setReverting(true);

        (bool ok,,) = adapter.readLatest();
        assertFalse(ok);
    }

    /// @dev No uptime feed configured is the correct setup on an L1 and in
    /// tests, and the wrong one on an L2 — the check is skipped, not faked.
    function test_sequencerCheckIsSkippedWhenNoFeedIsConfigured() public {
        ChainlinkRoundOracle bare = new ChainlinkRoundOracle(
            AggregatorV3Interface(address(feed)), AggregatorV3Interface(address(0)), MAX_STALENESS, SEQUENCER_GRACE
        );
        feed.push(2000e8, BASE_TIME);
        sequencer.set(1, BASE_TIME); // down, and irrelevant

        (bool ok,,) = bare.readLatest();
        assertTrue(ok);
    }

    // ------------------------------------------------------------------
    // Corporate-action pause (Robinhood Chain Stock Tokens)
    // ------------------------------------------------------------------

    function test_pausedStockFeedReadsAsUnavailable() public {
        MockPausableAggregatorV3 stockFeed = new MockPausableAggregatorV3(FEED_DECIMALS);
        ChainlinkRoundOracle stockAdapter = new ChainlinkRoundOracle(
            AggregatorV3Interface(address(stockFeed)),
            AggregatorV3Interface(address(sequencer)),
            MAX_STALENESS,
            SEQUENCER_GRACE
        );
        stockFeed.push(150e8, BASE_TIME);

        (bool ok,,) = stockAdapter.readLatest();
        assertTrue(ok);

        stockFeed.setPaused(true);
        (ok,,) = stockAdapter.readLatest();
        assertFalse(ok);
    }

    /// @dev Crypto feeds have no `oraclePaused()` at all. Calling it reverts,
    /// and reverting must read as "not paused" rather than "unavailable" —
    /// otherwise the flag would disable every non-stock market.
    function test_aFeedWithoutThePauseFlagIsTreatedAsUnpaused() public {
        feed.push(2000e8, BASE_TIME);
        (bool ok,,) = adapter.readLatest();
        assertTrue(ok);
    }

    // ------------------------------------------------------------------
    // The never-revert contract
    // ------------------------------------------------------------------
    //
    // The round contract tells "wait" from "cannot settle" off a boolean. Any
    // path in here that reverts instead of answering takes that away from it,
    // and all three of these did.

    /// @dev `catch` covers a failed external *call*, not a revert raised in
    /// the success block. The grace-period subtraction used to live in there,
    /// so a feed reporting a start time in the future underflowed and took
    /// the whole call down with it.
    function test_aSequencerFeedClaimingToStartInTheFutureDoesNotRevert() public {
        feed.push(2000e8, BASE_TIME);
        sequencer.set(0, BASE_TIME + 10 days);

        (bool ok,,) = adapter.readLatest();
        assertFalse(ok);
    }

    /// @dev `oracleRoundId + 1` is checked arithmetic, and the id comes
    /// straight from the caller.
    function test_theHighestPossibleRoundIdDoesNotRevert() public {
        feed.push(2000e8, BASE_TIME);

        (bool ok,) = adapter.readAt(type(uint80).max, BASE_TIME);
        assertFalse(ok);
    }

    /// @dev An answer big enough to overflow the decimal scaling is not a
    /// price, and must read as unusable rather than reverting on the multiply.
    function test_anAbsurdlyLargeAnswerDoesNotRevert() public {
        feed.push(type(int256).max, BASE_TIME);

        (bool ok,,) = adapter.readLatest();
        assertFalse(ok);
    }

    // ------------------------------------------------------------------
    // Deployment guards
    // ------------------------------------------------------------------

    function test_constructorRejectsBadConfiguration() public {
        vm.expectRevert(ChainlinkRoundOracle.ZeroAddress.selector);
        new ChainlinkRoundOracle(
            AggregatorV3Interface(address(0)), AggregatorV3Interface(address(sequencer)), MAX_STALENESS, SEQUENCER_GRACE
        );

        // A zero staleness bound rejects every price ever published: it fails
        // closed, but it fails always.
        vm.expectRevert(ChainlinkRoundOracle.InvalidParameters.selector);
        new ChainlinkRoundOracle(
            AggregatorV3Interface(address(feed)), AggregatorV3Interface(address(sequencer)), 0, SEQUENCER_GRACE
        );

        MockAggregatorV3 wideFeed = new MockAggregatorV3(20);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkRoundOracle.UnsupportedDecimals.selector, uint8(20)));
        new ChainlinkRoundOracle(
            AggregatorV3Interface(address(wideFeed)),
            AggregatorV3Interface(address(sequencer)),
            MAX_STALENESS,
            SEQUENCER_GRACE
        );
    }

    /// @dev An 18-decimal feed needs no scaling, and the adapter must not
    /// invent any.
    function test_anEighteenDecimalFeedIsPassedThroughUnscaled() public {
        MockAggregatorV3 wideFeed = new MockAggregatorV3(18);
        ChainlinkRoundOracle wideAdapter = new ChainlinkRoundOracle(
            AggregatorV3Interface(address(wideFeed)),
            AggregatorV3Interface(address(sequencer)),
            MAX_STALENESS,
            SEQUENCER_GRACE
        );
        wideFeed.push(2000e18, BASE_TIME);

        (bool ok, uint256 price,) = wideAdapter.readLatest();
        assertTrue(ok);
        assertEq(price, 2000e18);
    }
}
