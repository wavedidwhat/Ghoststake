// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";

import { EventRoundOracle } from "../src/EventRoundOracle.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";

/// A whole question, from opening the market to the winners being paid
/// (GHO-80).
///
/// The point of this file is that **nothing in `ParimutuelRound` knows what
/// kind of question it is settling**. The same contract, the same rake, the
/// same void rules and the same claim maths that run the price markets settle
/// "Brazil win the 2026 World Cup" — the only thing that changed is the
/// adapter behind `IRoundOracle`.
contract EventMarketTest is Test {
    ParimutuelRound internal market;
    EventRoundOracle internal oracle;
    ERC20Mock internal asset;

    address internal owner = makeAddr("owner");
    address internal committee = makeAddr("committee");
    address internal yesBettor = makeAddr("yesBettor");
    address internal noBettor = makeAddr("noBettor");
    address internal reporter = makeAddr("reporter");

    uint256 internal constant BOND = 500e18;
    uint64 internal constant EVENT_TIME = 1_800_000_000;
    uint64 internal constant CHALLENGE_WINDOW = 2 days;
    uint64 internal constant RAKE = 2e16; // 2%

    function setUp() public {
        asset = new ERC20Mock();
        oracle = new EventRoundOracle(
            owner,
            committee,
            IERC20(address(asset)),
            BOND,
            EVENT_TIME,
            CHALLENGE_WINDOW,
            7 days,
            "Brazil win the 2026 World Cup",
            "ipfs://criteria",
            keccak256("the final whistle of the final, per FIFA")
        );

        market = new ParimutuelRound(
            IERC20(address(asset)),
            IRoundOracle(address(oracle)),
            RAKE,
            ParimutuelRound.Timing({ entryCutoff: 1 hours, lockWindow: 1 days, resolveDeadline: 30 days }),
            10e18,
            owner,
            owner
        );

        vm.prank(owner);
        oracle.setMarket(address(market), 1);

        for (uint256 i = 0; i < 3; i++) {
            address who = [yesBettor, noBettor, reporter][i];
            asset.mint(who, 10_000e18);
            vm.startPrank(who);
            asset.approve(address(market), type(uint256).max);
            asset.approve(address(oracle), type(uint256).max);
            vm.stopPrank();
        }

        // Well before the event, so a round can run to its close.
        vm.warp(EVENT_TIME - 30 days);
    }

    /// @dev The happy path, which is the one worth reading: a question opens,
    /// people answer it, the event happens, somebody claims the outcome with
    /// a bond, nobody argues, and the winners are paid by the same code that
    /// pays a price market's winners.
    function test_aQuestionIsAskedAnsweredAndPaid() public {
        // 1. A market on the question. The strike is the sentinel the oracle
        //    answers against — Yes lands above it, No below.
        vm.prank(owner);
        uint256 roundId =
            market.openRound(uint64(block.timestamp), uint64(EVENT_TIME - 1 days), uint64(EVENT_TIME + 1 days));

        // 2. Two people disagree. 300 on Yes, 100 on No.
        vm.prank(yesBettor);
        market.takePosition(roundId, ParimutuelRound.Side.Up, 300e18);
        vm.prank(noBettor);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 100e18);

        // 3. Entry closes and the round locks. No feed is read: on a market
        //    deployed before GHO-79 the lock takes the oracle's sentinel,
        //    and after it the strike was set at open. Either way it is 1e18.
        vm.warp(EVENT_TIME - 1 days);
        market.lockRound(roundId);
        assertEq(market.rounds(roundId).lockPrice, oracle.STRIKE(), "the round struck somewhere else");

        // 4. The event happens and someone reports it, with their bond and
        //    the document it is judged against.
        vm.warp(EVENT_TIME + 1);
        vm.prank(reporter);
        oracle.propose(EventRoundOracle.Outcome.Yes, "ipfs://evidence", keccak256("scoreboard"));

        // Nothing can settle while the claim can still be argued with.
        vm.warp(EVENT_TIME + 1 days);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.OracleUnavailable.selector, roundId));
        market.resolveRound(roundId, 0);

        // 5. Nobody argued. The claim becomes the answer.
        vm.warp(oracle.challengeClosesAt());
        oracle.finalise();

        market.resolveRound(roundId, 0);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        assertEq(uint256(round.status), uint256(ParimutuelRound.Status.Resolved));
        assertEq(uint256(round.winner), uint256(ParimutuelRound.Side.Up), "Yes won and the round says otherwise");

        // 6. The winners are paid by the ordinary claim path: the whole pool,
        //    less the 2% rake, in proportion to what each of them staked.
        uint256 pool = 400e18;
        uint256 rake = (pool * RAKE) / 1e18;
        assertEq(market.claimableOf(roundId, yesBettor), pool - rake, "the only Yes should take the pool");
        assertEq(market.claimableOf(roundId, noBettor), 0);

        uint256 before = asset.balanceOf(yesBettor);
        vm.prank(yesBettor);
        market.claim(roundId, yesBettor);
        assertEq(asset.balanceOf(yesBettor), before + pool - rake);
    }

    /// @dev A question the process could not answer pays nobody. The bonds go
    /// back, the oracle stays silent, and the round is unwound by the same
    /// escape hatch a dead price feed would need — every stake refunded.
    function test_aQuestionNobodyWouldStandBehindRefundsEveryone() public {
        vm.prank(owner);
        uint256 roundId =
            market.openRound(uint64(block.timestamp), uint64(EVENT_TIME - 1 days), uint64(EVENT_TIME + 1 days));

        vm.prank(yesBettor);
        market.takePosition(roundId, ParimutuelRound.Side.Up, 300e18);
        vm.prank(noBettor);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 100e18);

        vm.warp(EVENT_TIME - 1 days);
        market.lockRound(roundId);

        // The event passes and nobody ever claims an outcome.
        vm.warp(EVENT_TIME + 40 days);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.OracleUnavailable.selector, roundId));
        market.resolveRound(roundId, 0);

        vm.prank(owner);
        market.voidUnsettledRound(roundId);

        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void));
        assertEq(market.claimableOf(roundId, yesBettor), 300e18, "a void has to refund in full");
        assertEq(market.claimableOf(roundId, noBettor), 100e18);
        assertEq(market.protocolFees(), 0, "the protocol took a rake on a question it could not answer");
    }

    /// @dev A challenge the committee upholds against the proposer flips the
    /// outcome, and the round pays the other side. The money follows the
    /// ruling, not the claim.
    function test_aRulingAgainstTheProposerPaysTheOtherSide() public {
        vm.prank(owner);
        uint256 roundId =
            market.openRound(uint64(block.timestamp), uint64(EVENT_TIME - 1 days), uint64(EVENT_TIME + 1 days));

        vm.prank(yesBettor);
        market.takePosition(roundId, ParimutuelRound.Side.Up, 300e18);
        vm.prank(noBettor);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 100e18);

        vm.warp(EVENT_TIME - 1 days);
        market.lockRound(roundId);

        // The proposer holds Yes and claims Yes. Allowed, recorded, and
        // exactly the case the window exists for.
        vm.warp(EVENT_TIME + 1);
        vm.prank(yesBettor);
        oracle.propose(EventRoundOracle.Outcome.Yes, "ipfs://evidence", keccak256("scoreboard"));
        assertEq(oracle.proposerStake(), 300e18, "the proposer's own interest was not recorded");

        vm.prank(noBettor);
        oracle.challenge();

        vm.prank(committee);
        oracle.rule(EventRoundOracle.Outcome.No, "ipfs://ruling");

        // A ruling does not make the round settleable early: the round still
        // closes when it said it would.
        vm.warp(EVENT_TIME + 1 days);
        market.resolveRound(roundId, 0);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        assertEq(uint256(round.winner), uint256(ParimutuelRound.Side.Down), "the ruling did not decide the round");

        uint256 pool = 400e18;
        uint256 rake = (pool * RAKE) / 1e18;
        assertEq(market.claimableOf(roundId, noBettor), pool - rake, "the challenger's side was not paid");
        assertEq(market.claimableOf(roundId, yesBettor), 0);
    }
}
