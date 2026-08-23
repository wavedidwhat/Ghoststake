// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";
import { MockRoundOracle } from "./mocks/MockRoundOracle.sol";
import { MockSettlementRouter } from "./mocks/MockSettlementRouter.sol";

/// @notice GHO-13: the four-phase parimutuel round.
///
/// The tests are grouped the way the contract's risks are: the phase gate
/// (can anyone enter once the strike is knowable), the payout arithmetic
/// (does the pool divide the way the docs claim), the void rules (does a
/// round that cannot settle honestly unwind rather than guess), and
/// solvency (can the contract ever owe more than it holds).
contract ParimutuelRoundTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAKE = 2e16; // 2%
    uint64 internal constant ENTRY_CUTOFF = 15 seconds;
    uint64 internal constant ORACLE_GRACE = 5 minutes;
    uint256 internal constant MIN_SIDE_POOL = 1 ether;

    uint64 internal constant ENTRY_WINDOW = 5 minutes;
    uint64 internal constant OBSERVATION_WINDOW = 5 minutes;

    uint256 internal constant START_PRICE = 2000e8;

    ParimutuelRound internal market;
    MockRoundOracle internal oracle;
    ERC20Mock internal token;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal keeper = makeAddr("keeper");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        // Rounds are scheduled against absolute timestamps, so the test clock
        // has to start somewhere plausible rather than at zero.
        vm.warp(1_700_000_000);

        token = new ERC20Mock();
        oracle = new MockRoundOracle(START_PRICE);
        market = new ParimutuelRound(
            IERC20(address(token)),
            IRoundOracle(address(oracle)),
            RAKE,
            ENTRY_CUTOFF,
            ORACLE_GRACE,
            MIN_SIDE_POOL,
            owner
        );

        address[3] memory users = [alice, bob, carol];
        for (uint256 i = 0; i < users.length; i++) {
            token.mint(users[i], 1_000_000 ether);
            vm.prank(users[i]);
            token.approve(address(market), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _openRound() internal returns (uint256 roundId) {
        vm.prank(owner);
        roundId = market.openRound(
            uint64(block.timestamp),
            uint64(block.timestamp) + ENTRY_WINDOW,
            uint64(block.timestamp) + ENTRY_WINDOW + OBSERVATION_WINDOW
        );
    }

    function _take(uint256 roundId, address user, ParimutuelRound.Side side, uint256 amount) internal {
        vm.prank(user);
        market.takePosition(roundId, side, amount);
    }

    /// @dev Fast-forwards to lock time and locks. Prices only move on a feed
    /// round advance, which `MockRoundOracle.setPrice` does for us.
    function _lock(uint256 roundId) internal {
        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(round.lockTime);
        market.lockRound(roundId);
    }

    function _resolveAt(uint256 roundId, uint256 closePrice) internal {
        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(round.closeTime);
        oracle.setPrice(closePrice);
        market.resolveRound(roundId);
    }

    /// @dev A two-sided round that locks cleanly: 100 up, 300 down.
    function _standardRound() internal returns (uint256 roundId) {
        roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, 60 ether);
        _take(roundId, bob, ParimutuelRound.Side.Up, 40 ether);
        _take(roundId, carol, ParimutuelRound.Side.Down, 300 ether);
        _lock(roundId);
    }

    // ------------------------------------------------------------------
    // Scheduling
    // ------------------------------------------------------------------

    function test_openRoundStoresThreePhaseBoundaries() public {
        uint256 roundId = _openRound();
        ParimutuelRound.Round memory round = market.rounds(roundId);

        assertEq(roundId, 1);
        assertEq(round.openTime, uint64(block.timestamp));
        assertEq(round.lockTime, uint64(block.timestamp) + ENTRY_WINDOW);
        assertEq(round.closeTime, uint64(block.timestamp) + ENTRY_WINDOW + OBSERVATION_WINDOW);
        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Open));
    }

    function test_openRoundRejectsScheduleShorterThanTheCutoff() public {
        uint64 now_ = uint64(block.timestamp);
        vm.prank(owner);
        vm.expectRevert(ParimutuelRound.InvalidSchedule.selector);
        market.openRound(now_, now_ + ENTRY_CUTOFF, now_ + 10 minutes);
    }

    function test_openRoundRejectsBackwardsSchedule() public {
        uint64 now_ = uint64(block.timestamp);

        vm.startPrank(owner);
        vm.expectRevert(ParimutuelRound.InvalidSchedule.selector);
        market.openRound(now_ - 1, now_ + 5 minutes, now_ + 10 minutes);

        vm.expectRevert(ParimutuelRound.InvalidSchedule.selector);
        market.openRound(now_, now_ + 5 minutes, now_ + 5 minutes);
        vm.stopPrank();
    }

    function test_onlyOwnerOpensRounds() public {
        uint64 now_ = uint64(block.timestamp);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        market.openRound(now_, now_ + 5 minutes, now_ + 10 minutes);
    }

    // ------------------------------------------------------------------
    // The phase gate
    // ------------------------------------------------------------------

    function test_entryClosesBeforeLockTimeByTheCutoffBuffer() public {
        uint256 roundId = _openRound();
        ParimutuelRound.Round memory round = market.rounds(roundId);
        uint64 cutoffAt = round.lockTime - ENTRY_CUTOFF;

        // One second inside the buffer: still open.
        vm.warp(cutoffAt - 1);
        assertTrue(market.entryIsOpen(roundId));
        _take(roundId, alice, ParimutuelRound.Side.Up, 10 ether);

        // The instant the buffer starts, entry is refused — this is the
        // window where a pending lockRound() transaction is visible.
        vm.warp(cutoffAt);
        assertFalse(market.entryIsOpen(roundId));
        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Cutoff));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.EntryClosed.selector, roundId, cutoffAt));
        market.takePosition(roundId, ParimutuelRound.Side.Down, 10 ether);
    }

    function test_entryRejectedBeforeOpenTime() public {
        uint64 openAt = uint64(block.timestamp) + 1 hours;
        vm.prank(owner);
        uint256 roundId = market.openRound(openAt, openAt + ENTRY_WINDOW, openAt + 10 minutes);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.TooEarly.selector, roundId, openAt));
        market.takePosition(roundId, ParimutuelRound.Side.Up, 10 ether);
    }

    function test_noEntryOrExitOnceLocked() public {
        uint256 roundId = _standardRound();
        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Observation));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ParimutuelRound.WrongPhase.selector, roundId, ParimutuelRound.Phase.Observation)
        );
        market.takePosition(roundId, ParimutuelRound.Side.Up, 10 ether);

        // And nothing can be pulled back out mid-round either: the only exit
        // is a claim, and a claim on an unresolved round has nothing in it.
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.NothingToClaim.selector, roundId, alice));
        market.claim(roundId, alice);
    }

    function test_lockBeforeLockTimeReverts() public {
        uint256 roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, 10 ether);
        _take(roundId, bob, ParimutuelRound.Side.Down, 10 ether);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(round.lockTime - 1);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.TooEarly.selector, roundId, round.lockTime));
        market.lockRound(roundId);
    }

    function test_resolveBeforeCloseTimeReverts() public {
        uint256 roundId = _standardRound();
        ParimutuelRound.Round memory round = market.rounds(roundId);

        vm.warp(round.closeTime - 1);
        oracle.setPrice(START_PRICE + 1);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.TooEarly.selector, roundId, round.closeTime));
        market.resolveRound(roundId);
    }

    function test_lockAndResolveArePermissionless() public {
        uint256 roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, 10 ether);
        _take(roundId, bob, ParimutuelRound.Side.Down, 10 ether);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(round.lockTime);
        vm.prank(carol); // not the keeper, not the owner
        market.lockRound(roundId);

        vm.warp(round.closeTime);
        oracle.setPrice(START_PRICE + 1);
        vm.prank(carol);
        market.resolveRound(roundId);

        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Resolved));
    }

    // ------------------------------------------------------------------
    // Pools and odds
    // ------------------------------------------------------------------

    function test_repeatEntriesOnOneSideSum() public {
        uint256 roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, 10 ether);
        _take(roundId, alice, ParimutuelRound.Side.Up, 15 ether);

        assertEq(market.stakeOf(roundId, alice, ParimutuelRound.Side.Up), 25 ether);
        assertEq(market.poolOf(roundId, ParimutuelRound.Side.Up), 25 ether);
    }

    /// @dev Hedging both sides is allowed and needs no ban: the loss is
    /// exactly the rake on the whole stake, which is the discouragement.
    function test_hedgingBothSidesLosesExactlyTheRake() public {
        uint256 roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, 50 ether);
        _take(roundId, alice, ParimutuelRound.Side.Down, 50 ether);
        _take(roundId, bob, ParimutuelRound.Side.Up, 100 ether);
        _take(roundId, carol, ParimutuelRound.Side.Down, 100 ether);
        _lock(roundId);
        _resolveAt(roundId, START_PRICE + 1);

        uint256 before = token.balanceOf(alice);
        market.claim(roundId, alice);
        uint256 recovered = token.balanceOf(alice) - before;

        // Pool 300, rake 6, distributable 294. Up pool 150, alice holds 50 of
        // it, so she gets 98 back against 100 staked — the 2 wei-scaled loss
        // is her share of the rake on the full 100.
        assertEq(recovered, 98 ether);
    }

    function test_oddsAreDerivedAndMoveWithEveryEntry() public {
        uint256 roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, 100 ether);
        _take(roundId, carol, ParimutuelRound.Side.Down, 100 ether);

        // 200 in, 2% rake, 196 distributable over a 100 side: 1.96x.
        assertEq(market.oddsOf(roundId, ParimutuelRound.Side.Up), 196e16);

        // Another 200 onto Down and the Up multiple nearly doubles. Nothing
        // was "set" — the number is a function of the pools.
        _take(roundId, carol, ParimutuelRound.Side.Down, 200 ether);
        assertEq(market.oddsOf(roundId, ParimutuelRound.Side.Up), 392e16);
        assertEq(market.oddsOf(roundId, ParimutuelRound.Side.Down), 1306666666666666666);
    }

    function test_oddsOfEmptySideIsZeroNotInfinite() public {
        uint256 roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, 100 ether);
        assertEq(market.oddsOf(roundId, ParimutuelRound.Side.Down), 0);
    }

    // ------------------------------------------------------------------
    // Resolution and payouts
    // ------------------------------------------------------------------

    function test_winnersSplitPoolMinusRakeProRata() public {
        uint256 roundId = _standardRound();
        _resolveAt(roundId, START_PRICE + 1); // Up wins

        ParimutuelRound.Round memory round = market.rounds(roundId);
        assertEq(uint256(round.winner), uint256(ParimutuelRound.Side.Up));
        assertEq(round.lockPrice, START_PRICE);
        assertEq(round.closePrice, START_PRICE + 1);

        // Pool 400, rake 2% = 8, distributable 392 over a 100 Up side.
        assertEq(round.rakeTaken, 8 ether);
        assertEq(market.protocolFees(), 8 ether);
        assertEq(market.claimableOf(roundId, alice), 2352e17); // 60/100 x 392
        assertEq(market.claimableOf(roundId, bob), 1568e17); // 40/100 x 392
        assertEq(market.claimableOf(roundId, carol), 0);

        uint256 aliceBefore = token.balanceOf(alice);
        market.claim(roundId, alice);
        assertEq(token.balanceOf(alice) - aliceBefore, 2352e17);
    }

    function test_downSideWinsOnAFallingPrice() public {
        uint256 roundId = _standardRound();
        _resolveAt(roundId, START_PRICE - 1);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        assertEq(uint256(round.winner), uint256(ParimutuelRound.Side.Down));
        // Carol is the whole Down side, so she takes the entire 392.
        assertEq(market.claimableOf(roundId, carol), 392 ether);
        assertEq(market.claimableOf(roundId, alice), 0);
    }

    function test_losersGetNothing() public {
        uint256 roundId = _standardRound();
        _resolveAt(roundId, START_PRICE + 1);

        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.NothingToClaim.selector, roundId, carol));
        market.claim(roundId, carol);
    }

    function test_claimIsOncePerRound() public {
        uint256 roundId = _standardRound();
        _resolveAt(roundId, START_PRICE + 1);

        market.claim(roundId, alice);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.AlreadyClaimed.selector, roundId, alice));
        market.claim(roundId, alice);
        assertEq(market.claimableOf(roundId, alice), 0);
    }

    /// @dev Anyone may pay the gas, but the money still goes to the holder.
    function test_thirdPartyClaimPaysTheHolder() public {
        uint256 roundId = _standardRound();
        _resolveAt(roundId, START_PRICE + 1);

        uint256 aliceBefore = token.balanceOf(alice);
        uint256 keeperBefore = token.balanceOf(keeper);
        vm.prank(keeper);
        market.claim(roundId, alice);

        assertEq(token.balanceOf(alice) - aliceBefore, 2352e17);
        assertEq(token.balanceOf(keeper), keeperBefore);
    }

    // ------------------------------------------------------------------
    // Void rules
    // ------------------------------------------------------------------

    function test_thinSideVoidsAtLockAndRefundsInFull() public {
        uint256 roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, 100 ether);
        _take(roundId, carol, ParimutuelRound.Side.Down, MIN_SIDE_POOL - 1);

        _lock(roundId);

        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void));
        // No rake on a void: everyone is made exactly whole.
        assertEq(market.protocolFees(), 0);
        assertEq(market.claimableOf(roundId, alice), 100 ether);
        assertEq(market.claimableOf(roundId, carol), MIN_SIDE_POOL - 1);

        uint256 before = token.balanceOf(alice);
        market.claim(roundId, alice);
        assertEq(token.balanceOf(alice) - before, 100 ether);
    }

    /// @dev The protocol must never fill the empty side itself. Filling it
    /// would give the protocol a directional position, which is the one thing
    /// the parimutuel design buys us freedom from — so the round voids even
    /// though the protocol could trivially "rescue" it.
    function test_emptySideVoidsRatherThanBeingSeeded() public {
        uint256 roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, 100 ether);

        _lock(roundId);

        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void));
        assertEq(market.claimableOf(roundId, alice), 100 ether);
        assertEq(token.balanceOf(address(market)), 100 ether);
    }

    function test_oracleFailureInsideGraceRevertsAndCanBeRetried() public {
        uint256 roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, 100 ether);
        _take(roundId, carol, ParimutuelRound.Side.Down, 100 ether);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(round.lockTime);
        oracle.setOk(false);

        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.OracleUnavailable.selector, roundId));
        market.lockRound(roundId);

        // A hiccup should cost a retry, not the round.
        vm.warp(round.lockTime + ORACLE_GRACE);
        oracle.setOk(true);
        market.lockRound(roundId);
        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Observation));
    }

    function test_oracleFailurePastGraceVoidsAtLock() public {
        uint256 roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, 100 ether);
        _take(roundId, carol, ParimutuelRound.Side.Down, 100 ether);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(round.lockTime + ORACLE_GRACE + 1);
        oracle.setOk(false);

        market.lockRound(roundId);
        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void));
        assertEq(market.claimableOf(roundId, alice), 100 ether);
        assertEq(market.claimableOf(roundId, carol), 100 ether);
    }

    function test_oracleFailurePastGraceVoidsAtResolve() public {
        uint256 roundId = _standardRound();
        ParimutuelRound.Round memory round = market.rounds(roundId);

        vm.warp(round.closeTime + ORACLE_GRACE + 1);
        oracle.setOk(false);
        market.resolveRound(roundId);

        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void));
        assertEq(market.protocolFees(), 0);
        assertEq(market.claimableOf(roundId, carol), 300 ether);
    }

    /// @dev A feed that has not moved since the lock read would settle the
    /// round on a price compared against itself.
    function test_staleFeedRoundBlocksResolveThenVoidsPastGrace() public {
        uint256 roundId = _standardRound();
        ParimutuelRound.Round memory round = market.rounds(roundId);
        uint80 lockRoundId = market.rounds(roundId).lockOracleRoundId;

        // Price moved but the feed round did not — exactly what a stale read
        // looks like from this contract's side.
        oracle.setPriceWithoutAdvancing(START_PRICE + 5);
        vm.warp(round.closeTime);
        vm.expectRevert(
            abi.encodeWithSelector(ParimutuelRound.OracleRoundNotAdvanced.selector, roundId, lockRoundId, lockRoundId)
        );
        market.resolveRound(roundId);

        vm.warp(round.closeTime + ORACLE_GRACE + 1);
        market.resolveRound(roundId);
        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void));
    }

    function test_exactTieVoids() public {
        uint256 roundId = _standardRound();
        _resolveAt(roundId, START_PRICE);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void));
        assertEq(round.closePrice, START_PRICE);
        assertEq(market.protocolFees(), 0);
        assertEq(market.claimableOf(roundId, alice), 60 ether);
        assertEq(market.claimableOf(roundId, carol), 300 ether);
    }

    function test_neverLockedRoundVoidsOnlyAfterTheGraceWindow() public {
        uint256 roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, 100 ether);
        _take(roundId, carol, ParimutuelRound.Side.Down, 100 ether);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        uint64 deadline = round.lockTime + ORACLE_GRACE;

        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.TooEarly.selector, roundId, deadline + 1));
        market.voidUnlockedRound(roundId);

        vm.warp(deadline + 1);
        market.voidUnlockedRound(roundId);
        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void));
        assertEq(market.claimableOf(roundId, alice), 100 ether);
    }

    /// @dev The attack this closes: this contract reads the feed's *current*
    /// price, so an unbounded resolve window hands the choice of closing
    /// price to whoever calls it. Carol is losing here — she waits until the
    /// price crosses back under the strike and calls `resolveRound` at the
    /// moment that makes her win. Bounding the window means her late call
    /// voids the round instead of stealing it.
    function test_lateResolveVoidsRatherThanSettlingAtAPriceTheCallerChose() public {
        uint256 roundId = _standardRound();
        ParimutuelRound.Round memory round = market.rounds(roundId);

        // Price is up at close: carol's Down side is losing.
        vm.warp(round.closeTime);
        oracle.setPrice(START_PRICE + 100);

        // She sits on it until the price comes back her way.
        vm.warp(round.closeTime + ORACLE_GRACE + 1);
        oracle.setPrice(START_PRICE - 100);
        vm.prank(carol);
        market.resolveRound(roundId);

        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void));
        assertEq(market.protocolFees(), 0);
        // Nobody wins a round nobody resolved on time; everyone is refunded.
        assertEq(market.claimableOf(roundId, carol), 300 ether);
        assertEq(market.claimableOf(roundId, alice), 60 ether);
    }

    /// @dev `voidUnlockedRound` is not that escape hatch, and must not become
    /// one: it stops at lock, where `resolveRound`'s own window check takes
    /// over.
    function test_voidUnlockedRoundRefusesALockedRound() public {
        uint256 roundId = _standardRound();
        ParimutuelRound.Round memory round = market.rounds(roundId);

        vm.warp(round.closeTime + 30 days);
        vm.expectRevert(
            abi.encodeWithSelector(ParimutuelRound.WrongPhase.selector, roundId, ParimutuelRound.Phase.Observation)
        );
        market.voidUnlockedRound(roundId);
    }

    /// @dev The same discretion exists at lock, where a late caller would be
    /// choosing the strike price rather than the closing one.
    function test_lateLockVoidsEvenWithAHealthyOracle() public {
        uint256 roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, 100 ether);
        _take(roundId, carol, ParimutuelRound.Side.Down, 100 ether);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(round.lockTime + ORACLE_GRACE + 1);
        oracle.setPrice(START_PRICE + 500); // feed is perfectly healthy
        market.lockRound(roundId);

        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void));
        assertEq(market.claimableOf(roundId, alice), 100 ether);
    }

    // ------------------------------------------------------------------
    // Borrowed funds: the router / settlement sink seam
    // ------------------------------------------------------------------

    function test_onlyWhitelistedRoutersCanOpenPositionsForOthers() public {
        uint256 roundId = _openRound();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.NotRouter.selector, bob));
        market.takePositionFor(roundId, alice, ParimutuelRound.Side.Up, 10 ether);
    }

    function test_routerFundedPayoutRoutesBackToTheRouter() public {
        MockSettlementRouter router = _router();
        uint256 roundId = _openRound();

        // Alice's position is opened with funds the router holds for her.
        token.mint(address(router), 100 ether);
        router.open(roundId, alice, ParimutuelRound.Side.Up, 100 ether);
        _take(roundId, carol, ParimutuelRound.Side.Down, 100 ether);
        _lock(roundId);
        _resolveAt(roundId, START_PRICE + 1);

        uint256 aliceBefore = token.balanceOf(alice);
        uint256 payout = market.claim(roundId, alice);

        // 200 pool, 4 rake, 196 to the single Up staker — and none of it
        // touches alice's wallet, because it is owed against her debt.
        assertEq(payout, 196 ether);
        assertEq(token.balanceOf(address(router)), 196 ether);
        assertEq(token.balanceOf(alice), aliceBefore);
        assertEq(router.settledFor(alice), 196 ether);
        assertEq(router.callCount(), 1);
    }

    /// @dev The requirement that makes a void safe for a borrower: the refund
    /// goes back where the funds came from, so the loan can be closed and the
    /// user ends exactly where they started.
    function test_routerFundedRefundOnVoidRoutesBackToTheRouter() public {
        MockSettlementRouter router = _router();
        uint256 roundId = _openRound();

        token.mint(address(router), 100 ether);
        router.open(roundId, alice, ParimutuelRound.Side.Up, 100 ether);
        _lock(roundId); // Down side empty: void

        market.claim(roundId, alice);
        assertEq(token.balanceOf(address(router)), 100 ether);
        assertEq(router.settledFor(alice), 100 ether);
    }

    function test_mixingOwnAndBorrowedFundsInOneRoundIsRejected() public {
        MockSettlementRouter router = _router();
        uint256 roundId = _openRound();

        token.mint(address(router), 100 ether);
        router.open(roundId, alice, ParimutuelRound.Side.Up, 50 ether);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.MixedFunding.selector, roundId, alice));
        market.takePosition(roundId, ParimutuelRound.Side.Up, 50 ether);

        // And the same in the other order, in a fresh round.
        uint256 second = _openRound();
        _take(second, alice, ParimutuelRound.Side.Down, 50 ether);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.MixedFunding.selector, second, alice));
        router.open(second, alice, ParimutuelRound.Side.Down, 50 ether);
    }

    function _router() internal returns (MockSettlementRouter router) {
        router = new MockSettlementRouter(market, IERC20(address(token)));
        vm.prank(owner);
        market.setRouter(address(router), true);
    }

    // ------------------------------------------------------------------
    // Fees and solvency
    // ------------------------------------------------------------------

    function test_ownerCanOnlyWithdrawCollectedRake() public {
        uint256 roundId = _standardRound();
        _resolveAt(roundId, START_PRICE + 1);

        // 400 tokens sit in the contract but only 8 of them are the
        // protocol's; the rest is owed to winners who have not claimed yet.
        assertEq(token.balanceOf(address(market)), 400 ether);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.InsufficientFees.selector, 9 ether, 8 ether));
        market.withdrawFees(treasury, 9 ether);

        vm.prank(owner);
        market.withdrawFees(treasury, 8 ether);
        assertEq(token.balanceOf(treasury), 8 ether);
        assertEq(market.protocolFees(), 0);
    }

    function test_unclaimedWinningsSurviveAFeeWithdrawal() public {
        uint256 roundId = _standardRound();
        _resolveAt(roundId, START_PRICE + 1);

        vm.prank(owner);
        market.withdrawFees(treasury, 8 ether);

        market.claim(roundId, alice);
        market.claim(roundId, bob);
        assertEq(token.balanceOf(address(market)), 0);
    }

    /// @dev The property that matters most: whatever happens, the contract
    /// holds at least what it still owes. Floor division on payouts means it
    /// can hold marginally more (stranded dust), never less.
    function test_contractNeverOwesMoreThanItHolds() public {
        uint256 roundId = _openRound();
        // Deliberately awkward numbers so the division does not come out even.
        _take(roundId, alice, ParimutuelRound.Side.Up, 33 ether + 7);
        _take(roundId, bob, ParimutuelRound.Side.Up, 11 ether + 3);
        _take(roundId, carol, ParimutuelRound.Side.Down, 97 ether + 1);
        _lock(roundId);
        _resolveAt(roundId, START_PRICE + 1);

        uint256 owed = market.claimableOf(roundId, alice) + market.claimableOf(roundId, bob) + market.protocolFees();
        assertLe(owed, token.balanceOf(address(market)));

        market.claim(roundId, alice);
        market.claim(roundId, bob);
        uint256 fees = market.protocolFees();
        vm.prank(owner);
        market.withdrawFees(treasury, fees);

        // Dust is bounded by one wei per claimant.
        assertLe(token.balanceOf(address(market)), 2);
    }

    function test_zeroStakeIsRejected() public {
        uint256 roundId = _openRound();
        vm.prank(alice);
        vm.expectRevert(ParimutuelRound.ZeroAmount.selector);
        market.takePosition(roundId, ParimutuelRound.Side.Up, 0);
    }

    function test_unknownRoundIsNotAPhase() public {
        assertEq(uint256(market.phaseOf(99)), uint256(ParimutuelRound.Phase.None));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.UnknownRound.selector, 99));
        market.takePosition(99, ParimutuelRound.Side.Up, 1 ether);
    }

    function test_constructorRejectsIndefensibleParameters() public {
        uint256 tooMuchRake = market.MAX_RAKE() + 1;

        vm.expectRevert(ParimutuelRound.InvalidParameters.selector);
        new ParimutuelRound(
            IERC20(address(token)),
            IRoundOracle(address(oracle)),
            tooMuchRake,
            ENTRY_CUTOFF,
            ORACLE_GRACE,
            MIN_SIDE_POOL,
            owner
        );

        // A zero cutoff reopens the lock-transaction front-run.
        vm.expectRevert(ParimutuelRound.InvalidParameters.selector);
        new ParimutuelRound(
            IERC20(address(token)), IRoundOracle(address(oracle)), RAKE, 0, ORACLE_GRACE, MIN_SIDE_POOL, owner
        );

        // A zero floor lets a round resolve with an empty winning side.
        vm.expectRevert(ParimutuelRound.InvalidParameters.selector);
        new ParimutuelRound(
            IERC20(address(token)), IRoundOracle(address(oracle)), RAKE, ENTRY_CUTOFF, ORACLE_GRACE, 0, owner
        );
    }

    // ------------------------------------------------------------------
    // Fuzz
    // ------------------------------------------------------------------

    /// @dev However the pools land, the winners plus the rake never exceed
    /// what was staked.
    function testFuzz_payoutsNeverExceedTheStakedPool(uint96 upA, uint96 upB, uint96 down) public {
        upA = uint96(bound(upA, MIN_SIDE_POOL, 100_000 ether));
        upB = uint96(bound(upB, 1, 100_000 ether));
        down = uint96(bound(down, MIN_SIDE_POOL, 100_000 ether));

        uint256 roundId = _openRound();
        _take(roundId, alice, ParimutuelRound.Side.Up, upA);
        _take(roundId, bob, ParimutuelRound.Side.Up, upB);
        _take(roundId, carol, ParimutuelRound.Side.Down, down);
        _lock(roundId);
        _resolveAt(roundId, START_PRICE + 1);

        uint256 owed = market.claimableOf(roundId, alice) + market.claimableOf(roundId, bob) + market.protocolFees();
        assertLe(owed, uint256(upA) + uint256(upB) + uint256(down));
    }
}
