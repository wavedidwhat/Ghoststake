// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";
import { ChainlinkRoundOracle } from "../src/ChainlinkRoundOracle.sol";
import { AggregatorV3Interface } from "../src/interfaces/AggregatorV3Interface.sol";
import { MockAggregatorV3, MockSequencerUptimeFeed } from "./mocks/MockAggregatorV3.sol";

/// @notice GHO-13 + GHO-14 end to end: a real round settling against the real
/// adapter over a feed with a real publication history.
///
/// The round tests drive `IRoundOracle` directly and the adapter tests drive
/// the feed directly. Neither can answer the question that actually matters —
/// **can a participant steer the outcome** — because that needs both halves at
/// once: the round deciding what to accept, and the adapter deciding what is
/// true. That question is what this file is for.
contract ChainlinkResolutionTest is Test {
    uint256 internal constant BASE_TIME = 1_700_000_000;
    uint256 internal constant MAX_STALENESS = 1 hours;
    uint256 internal constant SEQUENCER_GRACE = 30 minutes;

    uint256 internal constant RAKE = 2e16;
    uint64 internal constant ENTRY_CUTOFF = 15 seconds;
    uint64 internal constant LOCK_WINDOW = 60 seconds;
    uint64 internal constant RESOLVE_DEADLINE = 1 hours;
    uint256 internal constant MIN_SIDE_POOL = 1 ether;

    uint64 internal constant ENTRY_WINDOW = 5 minutes;
    uint64 internal constant OBSERVATION_WINDOW = 5 minutes;

    ParimutuelRound internal market;
    ChainlinkRoundOracle internal adapter;
    MockAggregatorV3 internal feed;
    MockSequencerUptimeFeed internal sequencer;
    ERC20Mock internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice"); // Up
    address internal carol = makeAddr("carol"); // Down

    function setUp() public {
        vm.warp(BASE_TIME);

        token = new ERC20Mock();
        feed = new MockAggregatorV3(8);
        sequencer = new MockSequencerUptimeFeed(0, BASE_TIME - 30 days);
        adapter = new ChainlinkRoundOracle(
            AggregatorV3Interface(address(feed)),
            AggregatorV3Interface(address(sequencer)),
            MAX_STALENESS,
            SEQUENCER_GRACE
        );
        market = new ParimutuelRound(
            IERC20(address(token)),
            IRoundOracle(address(adapter)),
            RAKE,
            ParimutuelRound.Timing({
                entryCutoff: ENTRY_CUTOFF,
                lockWindow: LOCK_WINDOW,
                resolveDeadline: RESOLVE_DEADLINE
            }),
            MIN_SIDE_POOL,
            owner
        );

        address[2] memory users = [alice, carol];
        for (uint256 i = 0; i < users.length; i++) {
            token.mint(users[i], 1_000 ether);
            vm.prank(users[i]);
            token.approve(address(market), type(uint256).max);
        }

        // A price exists before the round opens, as it would on a live feed.
        feed.push(2000e8, BASE_TIME);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Opens a two-sided round and locks it at `lockTime`, with the feed
    /// publishing on a believable cadence around the schedule.
    function _openAndLock() internal returns (uint256 roundId, uint64 closeTime) {
        vm.prank(owner);
        roundId = market.openRound(
            uint64(block.timestamp),
            uint64(block.timestamp) + ENTRY_WINDOW,
            uint64(block.timestamp) + ENTRY_WINDOW + OBSERVATION_WINDOW
        );

        vm.prank(alice);
        market.takePosition(roundId, ParimutuelRound.Side.Up, 100 ether);
        vm.prank(carol);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 100 ether);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        closeTime = round.closeTime;

        vm.warp(round.lockTime);
        feed.push(2000e8, round.lockTime);
        market.lockRound(roundId);
    }

    // ------------------------------------------------------------------
    // The happy path
    // ------------------------------------------------------------------

    function test_roundSettlesAgainstThePriceAtCloseTime() public {
        (uint256 roundId, uint64 closeTime) = _openAndLock();

        // Feed publishes across the observation window; the last one at or
        // before closeTime is what settles the round.
        feed.push(2050e8, closeTime - 60);
        uint80 pinned = feed.push(2100e8, closeTime - 10);
        feed.push(1900e8, closeTime + 10); // after close: not this one

        vm.warp(closeTime + 30);
        market.resolveRound(roundId, pinned);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        assertEq(uint256(round.winner), uint256(ParimutuelRound.Side.Up));
        assertEq(round.lockPrice, 2000e18); // scaled from the feed's 8 decimals
        assertEq(round.closePrice, 2100e18);
    }

    // ------------------------------------------------------------------
    // Can a participant steer it?
    // ------------------------------------------------------------------

    /// @dev Carol is losing. Her two options are to name a different feed
    /// round, or to wait for a better price and resolve later. The adapter
    /// takes away the first and the pinning takes away the second.
    function test_losingSideCannotChooseADifferentFeedRound() public {
        (uint256 roundId, uint64 closeTime) = _openAndLock();

        uint80 low = feed.push(1900e8, closeTime - 120); // she'd love this one
        uint80 pinned = feed.push(2100e8, closeTime - 10); // the true one
        feed.push(2200e8, closeTime + 10);

        vm.warp(closeTime + 30);

        // The earlier round is not the last one before closeTime, so the
        // adapter refuses to call it the price at closeTime.
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.OracleUnavailable.selector, roundId));
        market.resolveRound(roundId, low);

        // Neither can she reach for one published after the close.
        uint80 tooLate = feed.latestRoundId();
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.OracleUnavailable.selector, roundId));
        market.resolveRound(roundId, tooLate);

        // Only the true round is accepted, and it settles against her.
        vm.prank(carol);
        market.resolveRound(roundId, pinned);
        assertEq(uint256(market.rounds(roundId).winner), uint256(ParimutuelRound.Side.Up));
        assertEq(market.claimableOf(roundId, carol), 0);
    }

    /// @dev And waiting buys nothing: the price at `closeTime` does not
    /// change no matter how far the market moves afterwards, so a resolve an
    /// hour late is the same resolve.
    function test_waitingForABetterPriceChangesNothing() public {
        (uint256 roundId, uint64 closeTime) = _openAndLock();

        uint80 pinned = feed.push(2100e8, closeTime - 10);
        feed.push(2200e8, closeTime + 10);

        // Half an hour of the price collapsing in carol's favour.
        vm.warp(closeTime + 30 minutes);
        feed.push(1500e8, closeTime + 20 minutes);

        vm.prank(carol);
        market.resolveRound(roundId, pinned);

        assertEq(uint256(market.rounds(roundId).winner), uint256(ParimutuelRound.Side.Up));
        assertEq(market.rounds(roundId).closePrice, 2100e18);
    }

    // ------------------------------------------------------------------
    // Feed failures, end to end
    // ------------------------------------------------------------------

    /// @dev The feed goes quiet across the close. Nothing can be shown to be
    /// the price at `closeTime`, so nobody can settle the round — and nobody
    /// can fake a settlement either. Unwinding it is the owner's deliberate
    /// act, after the deadline.
    function test_aSilentFeedAcrossTheCloseLeavesTheRoundForTheOwnerToUnwind() public {
        (uint256 roundId, uint64 closeTime) = _openAndLock();

        // The only round that exists is the lock's own. It is not refused for
        // being the lock's — the adapter simply cannot show it to be the last
        // one before `closeTime`, because nothing has been published since.
        uint80 last = feed.latestRoundId();
        vm.warp(closeTime + 1);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.OracleUnavailable.selector, roundId));
        market.resolveRound(roundId, last);

        // A round id that simply does not exist gets no further.
        vm.warp(closeTime + RESOLVE_DEADLINE + 1);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.OracleUnavailable.selector, roundId));
        market.resolveRound(roundId, last + 1);

        vm.prank(owner);
        market.voidUnsettledRound(roundId);

        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void));
        assertEq(market.claimableOf(roundId, alice), 100 ether);
        assertEq(market.claimableOf(roundId, carol), 100 ether);
        assertEq(market.protocolFees(), 0);
    }

    /// @dev Sequencer down at lock time: the strike cannot be captured, and
    /// the lock window runs out. Everyone gets their money back rather than
    /// betting on a chain nobody could reach.
    function test_sequencerDowntimeAtLockVoidsTheRound() public {
        vm.prank(owner);
        uint256 roundId = market.openRound(
            uint64(block.timestamp),
            uint64(block.timestamp) + ENTRY_WINDOW,
            uint64(block.timestamp) + ENTRY_WINDOW + OBSERVATION_WINDOW
        );
        vm.prank(alice);
        market.takePosition(roundId, ParimutuelRound.Side.Up, 100 ether);
        vm.prank(carol);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 100 ether);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        sequencer.set(1, uint256(round.lockTime) - 60); // down

        vm.warp(round.lockTime);
        feed.push(2000e8, round.lockTime);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.OracleUnavailable.selector, roundId));
        market.lockRound(roundId);

        vm.warp(uint256(round.lockTime) + LOCK_WINDOW + 1);
        market.lockRound(roundId);

        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void));
        assertEq(market.claimableOf(roundId, alice), 100 ether);
    }

    /// @dev Downtime that straddles the close is worse than downtime now: the
    /// chain was unreachable at the instant being settled, so even a feed that
    /// has since recovered cannot answer for it — and the round is unwound
    /// rather than settled against a market people were locked out of.
    function test_sequencerDowntimeAcrossTheCloseLeavesTheRoundUnsettleable() public {
        (uint256 roundId, uint64 closeTime) = _openAndLock();

        uint80 pinned = feed.push(2100e8, closeTime - 10);
        feed.push(2200e8, closeTime + 10);

        // Sequencer came back well after closeTime, and the grace period has
        // since elapsed — so it is up *now*, but it was not up *then*.
        vm.warp(closeTime + RESOLVE_DEADLINE + 1);
        sequencer.set(0, closeTime + 5 minutes);

        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.OracleUnavailable.selector, roundId));
        market.resolveRound(roundId, pinned);

        vm.prank(owner);
        market.voidUnsettledRound(roundId);

        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void));
        assertEq(market.claimableOf(roundId, carol), 100 ether);
    }
}
