// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ParimutuelRound, IRoundOracle } from "../../src/ParimutuelRound.sol";
import { ChainlinkRoundOracle } from "../../src/ChainlinkRoundOracle.sol";
import { AggregatorV3Interface } from "../../src/interfaces/AggregatorV3Interface.sol";
import { MockAggregatorV3 } from "../mocks/MockAggregatorV3.sol";

/// @notice Adversarial suite against the prediction market. The threat model
/// is the one that has actually cost binary-option markets money: entering
/// once the outcome is knowable, choosing the settlement price by choosing
/// when (or with which feed round) to settle, and claiming twice.
contract AttackMarketTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAKE = 2e16;
    uint64 internal constant ENTRY_CUTOFF = 15 seconds;
    uint64 internal constant LOCK_WINDOW = 60 seconds;
    uint64 internal constant RESOLVE_DEADLINE = 1 hours;
    uint256 internal constant MIN_SIDE_POOL = 1 ether;
    uint64 internal constant ENTRY_WINDOW = 5 minutes;
    uint64 internal constant OBSERVATION_WINDOW = 5 minutes;
    uint256 internal constant HEARTBEAT = 1 hours;

    ParimutuelRound internal market;
    ChainlinkRoundOracle internal oracle;
    MockAggregatorV3 internal feed;
    ERC20Mock internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new ERC20Mock();
        feed = new MockAggregatorV3(8);
        feed.push(2000e8, block.timestamp);

        // The real adapter, not the permissive mock: `readAt`'s pinning rule
        // is exactly what these attacks are aimed at.
        oracle = new ChainlinkRoundOracle(
            AggregatorV3Interface(address(feed)), AggregatorV3Interface(address(0)), HEARTBEAT, 0
        );

        market = new ParimutuelRound(
            IERC20(address(token)),
            IRoundOracle(address(oracle)),
            RAKE,
            ParimutuelRound.Timing({
                entryCutoff: ENTRY_CUTOFF,
                lockWindow: LOCK_WINDOW,
                resolveDeadline: RESOLVE_DEADLINE
            }),
            MIN_SIDE_POOL,
            owner
        );

        address[3] memory users = [alice, bob, mallory];
        for (uint256 i = 0; i < users.length; i++) {
            token.mint(users[i], 1_000_000 ether);
            vm.prank(users[i]);
            token.approve(address(market), type(uint256).max);
        }
    }

    function _openRound() internal returns (uint256 id) {
        vm.prank(owner);
        id = market.openRound(
            uint64(block.timestamp),
            uint64(block.timestamp) + ENTRY_WINDOW,
            uint64(block.timestamp) + ENTRY_WINDOW + OBSERVATION_WINDOW
        );
    }

    function _enter(address who, uint256 id, ParimutuelRound.Side side, uint256 amount) internal {
        vm.prank(who);
        market.takePosition(id, side, amount);
    }

    // ================================================================
    // F. Entering once the outcome is knowable
    // ================================================================

    /// @dev F1 — the headline attack on any binary market: watch the price,
    /// then enter on the side that has already won.
    function test_F1_cannotEnterAfterTheStrikeIsCaptured() public {
        uint256 id = _openRound();
        _enter(alice, id, ParimutuelRound.Side.Up, 100 ether);
        _enter(bob, id, ParimutuelRound.Side.Down, 100 ether);

        vm.warp(block.timestamp + ENTRY_WINDOW);
        feed.push(2000e8, block.timestamp);
        market.lockRound(id);

        vm.expectRevert();
        vm.prank(mallory);
        market.takePosition(id, ParimutuelRound.Side.Up, 100 ether);
    }

    /// @dev F2 — the narrower version: sit in the mempool, see the pending
    /// `lockRound` transaction, read the price it is about to capture, and
    /// enter in the block before it lands. The cutoff buffer is what closes
    /// this, so entry must be refused for the whole buffer.
    function test_F2_entryIsRefusedForTheWholeCutoffBuffer() public {
        uint256 id = _openRound();
        _enter(alice, id, ParimutuelRound.Side.Up, 100 ether);

        vm.warp(block.timestamp + ENTRY_WINDOW - ENTRY_CUTOFF);
        assertFalse(market.entryIsOpen(id), "entry must already be closed at the cutoff boundary");

        vm.expectRevert();
        vm.prank(mallory);
        market.takePosition(id, ParimutuelRound.Side.Down, 100 ether);
    }

    /// @dev F3 — a late lock lets the caller choose the strike from a moving
    /// feed. The window bounds that discretion; past it the round must void
    /// rather than settle on a number someone picked.
    function test_F3_lateLockVoidsRatherThanLettingTheCallerPickTheStrike() public {
        uint256 id = _openRound();
        _enter(alice, id, ParimutuelRound.Side.Up, 100 ether);
        _enter(mallory, id, ParimutuelRound.Side.Down, 100 ether);

        vm.warp(block.timestamp + ENTRY_WINDOW + LOCK_WINDOW + 1);
        feed.push(1500e8, block.timestamp); // a level that suits Down
        market.lockRound(id);

        assertEq(
            uint256(market.phaseOf(id)), uint256(ParimutuelRound.Phase.Void), "voided, not locked on a chosen price"
        );
        assertEq(market.claimableOf(id, mallory), 100 ether, "everyone refunded in full");
    }

    // ================================================================
    // G. Choosing the settlement price
    // ================================================================

    /// @dev G1 — the attack the `readAt` pinning rule exists for. Mallory is
    /// losing at closeTime, waits for the feed to move back across the
    /// strike, then resolves naming the round she likes.
    function test_G1_cannotResolveOnAFavourableLaterFeedRound() public {
        uint256 id = _openRound();
        _enter(alice, id, ParimutuelRound.Side.Up, 100 ether);
        _enter(mallory, id, ParimutuelRound.Side.Down, 100 ether);

        vm.warp(block.timestamp + ENTRY_WINDOW);
        feed.push(2000e8, block.timestamp);
        market.lockRound(id);

        uint256 closeTime = market.rounds(id).closeTime;

        // At closeTime the price is up: Alice wins, Mallory loses.
        vm.warp(closeTime);
        feed.push(2100e8, closeTime);
        // Later the price collapses. Mallory wants THIS round to settle on.
        vm.warp(closeTime + 10 minutes);
        uint80 favourable = feed.push(1000e8, block.timestamp);

        vm.expectRevert();
        vm.prank(mallory);
        market.resolveRound(id, favourable);
    }

    /// @dev G2 — the mirror: name an *older* round that also sits inside the
    /// staleness bound, picking a price from a handful of candidates.
    function test_G2_cannotResolveOnAnEarlierFeedRound() public {
        uint256 id = _openRound();
        _enter(alice, id, ParimutuelRound.Side.Up, 100 ether);
        _enter(mallory, id, ParimutuelRound.Side.Down, 100 ether);

        vm.warp(block.timestamp + ENTRY_WINDOW);
        uint80 lockRoundId = feed.push(2000e8, block.timestamp);
        market.lockRound(id);

        uint256 closeTime = market.rounds(id).closeTime;
        vm.warp(closeTime);
        feed.push(2100e8, closeTime);
        vm.warp(closeTime + 1 minutes);
        feed.push(2100e8, block.timestamp);

        vm.expectRevert();
        vm.prank(mallory);
        market.resolveRound(id, lockRoundId - 1);
    }

    /// @dev G3 — resolution must be time-independent: calling on the second
    /// or an hour late has to produce the same answer, or waiting is a
    /// strategy.
    function test_G3_resolutionIsIndependentOfWhenItIsCalled() public {
        uint256 id = _openRound();
        _enter(alice, id, ParimutuelRound.Side.Up, 100 ether);
        _enter(mallory, id, ParimutuelRound.Side.Down, 100 ether);

        vm.warp(block.timestamp + ENTRY_WINDOW);
        feed.push(2000e8, block.timestamp);
        market.lockRound(id);

        uint256 closeTime = market.rounds(id).closeTime;
        vm.warp(closeTime);
        uint80 atClose = feed.push(2100e8, closeTime);
        vm.warp(closeTime + 1);
        feed.push(1000e8, block.timestamp);

        uint256 snapshot = vm.snapshotState();
        market.resolveRound(id, atClose);
        ParimutuelRound.Side early = market.rounds(id).winner;

        vm.revertToState(snapshot);
        vm.warp(closeTime + 55 minutes);
        feed.push(500e8, block.timestamp);
        market.resolveRound(id, atClose);

        assertEq(uint256(market.rounds(id).winner), uint256(early), "the answer must not depend on when it is asked");
    }

    // ================================================================
    // H. Claims and solvency
    // ================================================================

    /// @dev H1 — claim twice.
    function test_H1_cannotClaimTwice() public {
        uint256 id = _resolvedRoundUpWins();
        market.claim(id, alice);

        vm.expectRevert();
        market.claim(id, alice);
    }

    /// @dev H2 — claim someone else's payout into your own wallet. `claim`
    /// is deliberately open to any caller, so the recipient must be pinned.
    function test_H2_claimingForSomeoneElsePaysThem() public {
        uint256 id = _resolvedRoundUpWins();
        uint256 malloryBefore = token.balanceOf(mallory);
        uint256 aliceBefore = token.balanceOf(alice);

        vm.prank(mallory);
        uint256 amount = market.claim(id, alice);

        assertEq(token.balanceOf(mallory), malloryBefore, "the caller gets nothing");
        assertEq(token.balanceOf(alice) - aliceBefore, amount, "the holder gets it all");
    }

    /// @dev H3 — the loser claims.
    function test_H3_losingSideCannotClaim() public {
        uint256 id = _resolvedRoundUpWins();
        vm.expectRevert();
        market.claim(id, mallory);
    }

    /// @dev H4 — solvency. The sum of every payout plus the rake must never
    /// exceed what the round took in.
    function testFuzz_H4_roundNeverPaysOutMoreThanItTookIn(uint96 up, uint96 down, bool priceUp) public {
        uint256 a = bound(uint256(up), 1 ether, 100_000 ether);
        uint256 b = bound(uint256(down), 1 ether, 100_000 ether);

        uint256 id = _openRound();
        _enter(alice, id, ParimutuelRound.Side.Up, a);
        _enter(mallory, id, ParimutuelRound.Side.Down, b);

        vm.warp(block.timestamp + ENTRY_WINDOW);
        feed.push(2000e8, block.timestamp);
        market.lockRound(id);

        uint256 closeTime = market.rounds(id).closeTime;
        vm.warp(closeTime);
        uint80 atClose = feed.push(priceUp ? int256(2100e8) : int256(1900e8), closeTime);
        vm.warp(closeTime + 1);
        feed.push(2000e8, block.timestamp);
        market.resolveRound(id, atClose);

        uint256 paid;
        try market.claim(id, alice) returns (uint256 x) {
            paid += x;
        } catch { }
        try market.claim(id, mallory) returns (uint256 x) {
            paid += x;
        } catch { }

        assertLe(paid + market.protocolFees(), a + b, "a round can never pay out more than it took in");
        assertGe(token.balanceOf(address(market)), market.protocolFees(), "fees stay covered by real tokens");
    }

    /// @dev H5 — the owner reaching into stakes. `withdrawFees` must be
    /// bounded by the fee ledger, never by the token balance.
    function test_H5_ownerCannotWithdrawUserStakes() public {
        uint256 id = _openRound();
        _enter(alice, id, ParimutuelRound.Side.Up, 100 ether);
        _enter(mallory, id, ParimutuelRound.Side.Down, 100 ether);

        assertEq(token.balanceOf(address(market)), 200 ether, "stakes are sitting in the contract");
        vm.expectRevert();
        vm.prank(owner);
        market.withdrawFees(owner, 1 ether);
    }

    /// @dev H6 — open a position on someone's behalf without being a router.
    function test_H6_nonRouterCannotOpenPositionsForOthers() public {
        uint256 id = _openRound();
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.NotRouter.selector, mallory));
        vm.prank(mallory);
        market.takePositionFor(id, alice, ParimutuelRound.Side.Up, 100 ether);
    }

    /// @dev H7 — a thin round is not a market: one side taking the pot back
    /// minus rake is a fee charged for nothing.
    function test_H7_oneSidedRoundVoidsInsteadOfChargingRake() public {
        uint256 id = _openRound();
        _enter(alice, id, ParimutuelRound.Side.Up, 100 ether);

        vm.warp(block.timestamp + ENTRY_WINDOW);
        feed.push(2000e8, block.timestamp);
        market.lockRound(id);

        assertEq(uint256(market.phaseOf(id)), uint256(ParimutuelRound.Phase.Void), "thin round voids");
        assertEq(market.claimableOf(id, alice), 100 ether, "refunded in full, no rake");
        assertEq(market.protocolFees(), 0, "no rake on a round that did not run");
    }

    // ================================================================
    // X. Residual risk — demonstrations, not defences
    // ================================================================

    /// @dev X4 — STRIKE DISCRETION. `lockRound` reads "the price now", so
    /// whoever calls it picks the strike from whatever the feed printed
    /// during the 60-second window. The window bounds the discretion; it does
    /// not remove it. A Down bettor waits for a local high.
    function test_X4_theLockCallerPicksTheStrikeInsideTheWindow() public {
        uint256 id = _openRound();
        _enter(alice, id, ParimutuelRound.Side.Up, 100 ether);
        _enter(mallory, id, ParimutuelRound.Side.Down, 100 ether);
        uint64 lockTime = market.rounds(id).lockTime;

        uint256 snapshot = vm.snapshotState();

        // Honest keeper, on the second.
        vm.warp(lockTime);
        feed.push(2000e8, block.timestamp);
        market.lockRound(id);
        uint256 honestStrike = market.rounds(id).lockPrice;

        // Mallory instead waits for a high inside the same window.
        vm.revertToState(snapshot);
        vm.warp(lockTime);
        feed.push(2000e8, block.timestamp);
        vm.warp(lockTime + LOCK_WINDOW);
        feed.push(2080e8, block.timestamp);
        vm.prank(mallory);
        market.lockRound(id);
        uint256 chosenStrike = market.rounds(id).lockPrice;

        assertGt(chosenStrike, honestStrike, "the caller moved the strike in their own favour");
        emit log_named_uint(
            "strike discretion available inside the window (bps)", (chosenStrike - honestStrike) * 10_000 / honestStrike
        );
    }

    /// @dev X5 — OWNER CAN TURN A WIN INTO A REFUND. Past the resolve
    /// deadline the owner may void a round that was still perfectly
    /// settleable by anyone, converting a winner's payout into a refund. This
    /// is the one real privilege in the lifecycle.
    function test_X5_ownerCanVoidARoundThatWasStillSettleable() public {
        uint256 id = _openRound();
        _enter(alice, id, ParimutuelRound.Side.Up, 100 ether);
        _enter(mallory, id, ParimutuelRound.Side.Down, 100 ether);

        vm.warp(block.timestamp + ENTRY_WINDOW);
        feed.push(2000e8, block.timestamp);
        market.lockRound(id);

        uint256 closeTime = market.rounds(id).closeTime;
        vm.warp(closeTime);
        uint80 atClose = feed.push(2100e8, closeTime); // Alice has clearly won
        vm.warp(closeTime + 1);
        feed.push(2100e8, block.timestamp);

        // Nobody calls resolveRound, though anyone could have.
        vm.warp(closeTime + RESOLVE_DEADLINE + 1);
        vm.prank(owner);
        market.voidUnsettledRound(id);

        assertEq(uint256(market.phaseOf(id)), uint256(ParimutuelRound.Phase.Void), "the win became a refund");
        assertEq(market.claimableOf(id, mallory), 100 ether, "the loser got their stake back");
        assertEq(market.claimableOf(id, alice), 100 ether, "the winner got only their stake back");

        // The counterweight: the honest path was open to everyone the whole
        // time, so this only bites if nobody bothered to resolve.
        atClose; // named to document what could have been passed
    }

    function _resolvedRoundUpWins() internal returns (uint256 id) {
        id = _openRound();
        _enter(alice, id, ParimutuelRound.Side.Up, 100 ether);
        _enter(mallory, id, ParimutuelRound.Side.Down, 100 ether);

        vm.warp(block.timestamp + ENTRY_WINDOW);
        feed.push(2000e8, block.timestamp);
        market.lockRound(id);

        uint256 closeTime = market.rounds(id).closeTime;
        vm.warp(closeTime);
        uint80 atClose = feed.push(2100e8, closeTime);
        vm.warp(closeTime + 1);
        feed.push(2100e8, block.timestamp);
        market.resolveRound(id, atClose);
    }
}
