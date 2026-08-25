// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { DemoPriceFeed } from "../src/demo/DemoPriceFeed.sol";
import { ChainlinkRoundOracle } from "../src/ChainlinkRoundOracle.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";
import { AggregatorV3Interface } from "../src/interfaces/AggregatorV3Interface.sol";
import { MockUSDC } from "../script/mocks/MockUSDC.sol";

/// @notice GHO-29: the operator-driven feed behind the demo market.
///
/// The feed is deployed to a real chain and real settlement runs against it,
/// so what is tested here is that it behaves like an aggregator — ordered
/// rounds, kept history, no reuse — and not merely that `push` stores a
/// number. The last test is the one that matters: a full round opened,
/// locked, closed and settled inside a few seconds, which is the thing a live
/// demo cannot do on a real feed's heartbeat.
contract DemoPriceFeedTest is Test {
    uint256 internal constant BASE_TIME = 1_700_000_000;
    uint8 internal constant FEED_DECIMALS = 8;

    address internal operator = address(0xA11CE);
    address internal outsider = address(0xBEEF);

    DemoPriceFeed internal feed;

    function setUp() public {
        vm.warp(BASE_TIME);
        feed = new DemoPriceFeed(FEED_DECIMALS, "ETH / USD", operator);
    }

    // ------------------------------------------------------------------
    // Publishing
    // ------------------------------------------------------------------

    function test_pushIsOwnerOnly() public {
        // On a public testnet an open push is an open invitation to set the
        // settlement price of somebody else's live round.
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        feed.push(2000e8);

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        feed.pushAt(2000e8, BASE_TIME + 1);
    }

    function test_roundIdsIncreaseByOneAndKeepHistory() public {
        vm.startPrank(operator);
        assertEq(feed.push(2000e8), 1);
        vm.warp(BASE_TIME + 10);
        assertEq(feed.push(2100e8), 2);
        vm.warp(BASE_TIME + 20);
        assertEq(feed.push(1900e8), 3);
        vm.stopPrank();

        // History is the whole point: `readAt` names a past round and reads
        // its successor, so an aggregator that only remembers the latest
        // answer cannot settle anything.
        (, int256 first,, uint256 firstAt,) = feed.getRoundData(1);
        assertEq(first, 2000e8);
        assertEq(firstAt, BASE_TIME);

        (uint80 latestId, int256 latest,, uint256 latestAt,) = feed.latestRoundData();
        assertEq(latestId, 3);
        assertEq(latest, 1900e8);
        assertEq(latestAt, BASE_TIME + 20);
    }

    function test_timestampsMustStrictlyAdvance() public {
        vm.startPrank(operator);
        feed.push(2000e8);

        // Same block, same timestamp. Two rounds sharing an instant make "the
        // last round at or before `at`" ambiguous, and the adapter would then
        // settle on whichever of them the caller named.
        vm.expectRevert(abi.encodeWithSelector(DemoPriceFeed.TimestampNotAdvanced.selector, BASE_TIME, BASE_TIME));
        feed.push(2100e8);

        vm.expectRevert(abi.encodeWithSelector(DemoPriceFeed.TimestampNotAdvanced.selector, BASE_TIME, BASE_TIME - 1));
        feed.pushAt(2100e8, BASE_TIME - 1);

        vm.warp(BASE_TIME + 1);
        assertEq(feed.push(2100e8), 2);
        vm.stopPrank();
    }

    function test_refusesNonPositiveAnswers() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(DemoPriceFeed.NonPositiveAnswer.selector, int256(0)));
        feed.push(0);

        vm.expectRevert(abi.encodeWithSelector(DemoPriceFeed.NonPositiveAnswer.selector, int256(-1)));
        feed.push(-1);
        vm.stopPrank();
    }

    function test_unpublishedRoundsRevertLikeAnAggregator() public {
        vm.expectRevert(DemoPriceFeed.NoData.selector);
        feed.latestRoundData();

        vm.expectRevert(DemoPriceFeed.NoData.selector);
        feed.getRoundData(1);

        vm.prank(operator);
        feed.push(2000e8);

        vm.expectRevert(DemoPriceFeed.NoData.selector);
        feed.getRoundData(2);
    }

    function test_descriptionSaysWhatThisIs() public view {
        // Any surface rendering a market's feed description has to be able to
        // show a user that this price is set by hand.
        assertEq(feed.description(), "GHOSTSTAKE DEMO FEED (operator-set price) - ETH / USD");
        assertEq(feed.decimals(), FEED_DECIMALS);
        assertEq(feed.version(), 3);
    }

    /// @dev The adapter refuses a price published after the instant it is
    /// asked about, so overshooting stalls the operator's own demo rather
    /// than settling a round early.
    function test_aFutureTimestampIsAllowedAndTheAdapterIgnoresIt() public {
        ChainlinkRoundOracle adapter = _adapter(feed);

        vm.prank(operator);
        feed.pushAt(2000e8, BASE_TIME + 1 hours);

        (bool ok,,) = adapter.readLatest();
        assertFalse(ok, "a price from the future is not the price now");

        vm.warp(BASE_TIME + 1 hours);
        (ok,,) = adapter.readLatest();
        assertTrue(ok);
    }

    // ------------------------------------------------------------------
    // Through the adapter, and then through a whole round
    // ------------------------------------------------------------------

    function test_adapterPinsToTheRoundAfterTheCloseJustAsOnARealFeed() public {
        ChainlinkRoundOracle adapter = _adapter(feed);
        uint256 closeTime = BASE_TIME + 60;

        vm.prank(operator);
        feed.pushAt(2000e8, closeTime - 5);

        // Nothing published after the close yet: nothing to settle against.
        (bool ok,) = adapter.readAt(1, closeTime);
        assertFalse(ok);

        vm.warp(closeTime + 1);
        vm.prank(operator);
        feed.push(2100e8);

        (ok,) = adapter.readAt(1, closeTime);
        assertTrue(ok, "round 1 is now the last one at or before the close");

        // And the operator cannot then pick the later, more convenient round:
        // it was published after the close, so it is not the price then.
        (bool okLater,) = adapter.readAt(2, closeTime);
        assertFalse(okLater);
    }

    function test_aWholeRoundSettlesInSeconds() public {
        ChainlinkRoundOracle adapter = _adapter(feed);
        MockUSDC asset = new MockUSDC();

        ParimutuelRound market = new ParimutuelRound(
            IERC20(address(asset)),
            IRoundOracle(address(adapter)),
            0.02e18,
            ParimutuelRound.Timing({ entryCutoff: 5 seconds, lockWindow: 60 seconds, resolveDeadline: 1 hours }),
            10e6,
            operator
        );

        address up = address(0x11);
        address down = address(0x22);
        asset.mint(up, 100e6);
        asset.mint(down, 100e6);

        // The strike read is `readLatest`, so the feed has to be publishing
        // before the round opens — an empty feed reads as unavailable and the
        // round would void at lock for a reason that has nothing to do with
        // the market.
        vm.prank(operator);
        feed.push(2000e8);

        vm.prank(operator);
        uint256 roundId = market.openRound(uint64(BASE_TIME), uint64(BASE_TIME + 30), uint64(BASE_TIME + 60));

        vm.startPrank(up);
        asset.approve(address(market), 100e6);
        market.takePosition(roundId, ParimutuelRound.Side.Up, 100e6);
        vm.stopPrank();

        vm.startPrank(down);
        asset.approve(address(market), 100e6);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 100e6);
        vm.stopPrank();

        vm.warp(BASE_TIME + 30);
        market.lockRound(roundId);

        // Two pushes, and the order of them is the whole operational lesson.
        // The *settlement* price is the last round published at or before the
        // close; the round published after the close is what pins it there.
        // An operator who pushes only once, after the close, has published a
        // price that is not the price at `closeTime` and cannot settle with
        // it — which is exactly the failure this test hit first.
        vm.warp(BASE_TIME + 50);
        vm.prank(operator);
        uint80 closeRound = feed.push(2100e8);

        vm.warp(BASE_TIME + 61);
        vm.prank(operator);
        feed.push(2105e8);

        market.resolveRound(roundId, closeRound);

        assertEq(uint256(market.rounds(roundId).status), uint256(ParimutuelRound.Status.Resolved));
        assertEq(uint256(market.rounds(roundId).winner), uint256(ParimutuelRound.Side.Up));

        // 200 in, 2% rake, all of it to the one Up staker.
        uint256 payout = market.claimableOf(roundId, up);
        assertEq(payout, 196e6);
        assertEq(market.claimableOf(roundId, down), 0);

        market.claim(roundId, up);
        assertEq(asset.balanceOf(up), 196e6);
    }

    function _adapter(DemoPriceFeed feed_) private returns (ChainlinkRoundOracle) {
        return new ChainlinkRoundOracle(
            AggregatorV3Interface(address(feed_)),
            // No sequencer feed: this is an L1 in tests, and on an L2 the demo
            // market is wired to the same uptime feed as the real one.
            AggregatorV3Interface(address(0)),
            1 hours,
            30 minutes
        );
    }
}
