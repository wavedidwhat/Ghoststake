// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { EventRoundOracle } from "../src/EventRoundOracle.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";

/// A question no price feed can answer, settled by a bonded claim (GHO-80).
///
/// The properties worth holding are about *who can be paid and when*, so most
/// of these are about the paths that must not pay: a claim nobody argued with
/// during the window, a claim decided by someone who is not the arbiter, a
/// committee that goes quiet, and a round that tries to settle before any of
/// it has happened.
contract EventRoundOracleTest is Test {
    EventRoundOracle internal oracle;
    ERC20Mock internal bondAsset;

    address internal owner = makeAddr("owner");
    address internal committee = makeAddr("committee");
    address internal alice = makeAddr("alice");
    address internal mallory = makeAddr("mallory");

    uint256 internal constant BOND = 500e6;
    uint64 internal constant EVENT_TIME = 1_800_000_000;
    uint64 internal constant CHALLENGE_WINDOW = 2 days;
    uint64 internal constant RULING_DEADLINE = 7 days;

    bytes32 internal constant CRITERIA = keccak256("the final whistle of the final, per FIFA");

    function setUp() public {
        bondAsset = new ERC20Mock();
        oracle = new EventRoundOracle(
            owner,
            committee,
            IERC20(address(bondAsset)),
            BOND,
            EVENT_TIME,
            CHALLENGE_WINDOW,
            RULING_DEADLINE,
            "Brazil win the 2026 World Cup",
            "ipfs://criteria",
            CRITERIA
        );

        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? alice : mallory;
            bondAsset.mint(who, 10_000e6);
            vm.prank(who);
            bondAsset.approve(address(oracle), type(uint256).max);
        }

        vm.warp(EVENT_TIME + 1);
    }

    function _propose(address who, EventRoundOracle.Outcome outcome) internal {
        vm.prank(who);
        oracle.propose(outcome, "ipfs://evidence", keccak256("a screenshot of the scoreboard"));
    }

    // ------------------------------------------------------------------
    // Nothing is an answer until the window has passed
    // ------------------------------------------------------------------

    function test_theRoundGetsNoAnswerUntilAClaimIsFinal() public {
        (bool ok,) = oracle.readAt(0, block.timestamp);
        assertFalse(ok, "answered before anybody claimed anything");

        _propose(alice, EventRoundOracle.Outcome.Yes);
        (ok,) = oracle.readAt(0, block.timestamp);
        assertFalse(ok, "answered while the claim could still be challenged");

        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        oracle.finalise();

        uint256 price;
        (ok, price) = oracle.readAt(0, block.timestamp);
        assertTrue(ok);
        assertEq(price, oracle.YES());
        assertGt(price, oracle.STRIKE(), "Yes has to land above the strike, or the round pays No");
    }

    function test_aNoOutcomeSettlesBelowTheStrike() public {
        _propose(alice, EventRoundOracle.Outcome.No);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        oracle.finalise();

        (bool ok, uint256 price) = oracle.readAt(0, block.timestamp);
        assertTrue(ok);
        assertEq(price, oracle.NO());
        assertLt(price, oracle.STRIKE(), "No has to land below the strike, or the round pays Yes");
    }

    function test_nothingCanBeProposedBeforeTheEventHasHappened() public {
        vm.warp(EVENT_TIME - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(EventRoundOracle.TooEarly.selector, EVENT_TIME));
        oracle.propose(EventRoundOracle.Outcome.Yes, "ipfs://evidence", keccak256("x"));
    }

    function test_finaliseRefusesInsideTheWindow() public {
        _propose(alice, EventRoundOracle.Outcome.Yes);
        uint64 closesAt = oracle.challengeClosesAt();

        vm.expectRevert(abi.encodeWithSelector(EventRoundOracle.NotYet.selector, closesAt));
        oracle.finalise();

        // And the bond is still held, not quietly returned.
        assertEq(bondAsset.balanceOf(address(oracle)), BOND);
    }

    // ------------------------------------------------------------------
    // The bond is what makes arguing worth it
    // ------------------------------------------------------------------

    function test_anUnchallengedProposerGetsTheirBondBack() public {
        uint256 before = bondAsset.balanceOf(alice);
        _propose(alice, EventRoundOracle.Outcome.Yes);
        assertEq(bondAsset.balanceOf(alice), before - BOND, "the bond was not actually taken");

        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        oracle.finalise();

        assertEq(bondAsset.balanceOf(alice), before, "an honest proposal cost something");
        assertEq(bondAsset.balanceOf(address(oracle)), 0);
    }

    function test_aCorrectChallengerTakesTheLiarsBond() public {
        _propose(mallory, EventRoundOracle.Outcome.Yes);
        uint256 before = bondAsset.balanceOf(alice);

        vm.prank(alice);
        oracle.challenge();

        vm.prank(committee);
        oracle.rule(EventRoundOracle.Outcome.No, "ipfs://ruling");

        assertEq(bondAsset.balanceOf(alice), before + BOND, "challenging correctly has to pay");
        assertEq(bondAsset.balanceOf(address(oracle)), 0);
        assertEq(uint256(oracle.outcome()), uint256(EventRoundOracle.Outcome.No));
    }

    function test_aWrongChallengerPaysTheProposer() public {
        _propose(alice, EventRoundOracle.Outcome.Yes);
        // Captured after the bond is posted, so this is what she is out of
        // pocket by: an upheld claim returns her own bond *and* pays her the
        // challenger's.
        uint256 before = bondAsset.balanceOf(alice);

        vm.prank(mallory);
        oracle.challenge();

        vm.prank(committee);
        oracle.rule(EventRoundOracle.Outcome.Yes, "ipfs://ruling");

        assertEq(bondAsset.balanceOf(alice), before + BOND * 2, "an upheld claim has to pay its proposer");
        assertEq(bondAsset.balanceOf(address(oracle)), 0, "the arbiter kept a cut");
    }

    function test_challengingAfterTheWindowIsRefused() public {
        _propose(alice, EventRoundOracle.Outcome.Yes);
        uint64 closesAt = oracle.challengeClosesAt();
        vm.warp(closesAt);

        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(EventRoundOracle.NotYet.selector, closesAt));
        oracle.challenge();
    }

    // ------------------------------------------------------------------
    // Who may decide
    // ------------------------------------------------------------------

    function test_nobodyButTheArbiterCanRule() public {
        _propose(alice, EventRoundOracle.Outcome.Yes);
        vm.prank(mallory);
        oracle.challenge();

        for (uint256 i = 0; i < 3; i++) {
            address who = [owner, alice, mallory][i];
            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(EventRoundOracle.NotArbiter.selector, who));
            oracle.rule(EventRoundOracle.Outcome.Yes, "ipfs://ruling");
        }
    }

    /// @dev The owner's power is to say *who* decides, never *what* is
    /// decided. Worth pinning as an attack test: it is the difference between
    /// this and the operator call it replaces.
    function test_theOwnerCannotDecideAnOutcomeOrTouchABond() public {
        _propose(alice, EventRoundOracle.Outcome.Yes);
        vm.prank(mallory);
        oracle.challenge();

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(EventRoundOracle.NotArbiter.selector, owner));
        oracle.rule(EventRoundOracle.Outcome.Yes, "ipfs://ruling");

        // Replacing the committee is allowed, and still decides nothing.
        address replacement = makeAddr("newCommittee");
        vm.prank(owner);
        oracle.setArbiter(replacement);
        assertEq(bondAsset.balanceOf(address(oracle)), BOND * 2, "bonds moved on an arbiter change");

        vm.prank(replacement);
        oracle.rule(EventRoundOracle.Outcome.No, "ipfs://ruling");
        assertEq(uint256(oracle.outcome()), uint256(EventRoundOracle.Outcome.No));
    }

    function test_aFinalQuestionCannotHaveItsArbiterSwapped() public {
        _propose(alice, EventRoundOracle.Outcome.Yes);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        oracle.finalise();

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(EventRoundOracle.WrongState.selector, EventRoundOracle.State.Final));
        oracle.setArbiter(makeAddr("too late"));
    }

    function test_onlyTheOwnerCanReplaceTheArbiter() public {
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, mallory));
        oracle.setArbiter(mallory);
    }

    // ------------------------------------------------------------------
    // A committee that goes quiet
    // ------------------------------------------------------------------

    /// @dev The state everyone forgets. A silent committee must not be able to
    /// strand the bonds or the round — and must not be able to pick a winner
    /// by waiting, which is what paying either side on a timeout would let it
    /// do.
    function test_aSilentCommitteeEndsInRefundsAndNoAnswer() public {
        _propose(alice, EventRoundOracle.Outcome.Yes);
        uint256 aliceBefore = bondAsset.balanceOf(alice);
        vm.prank(mallory);
        oracle.challenge();
        uint256 malloryBefore = bondAsset.balanceOf(mallory);

        vm.expectRevert(abi.encodeWithSelector(EventRoundOracle.NotYet.selector, oracle.rulingDueAt()));
        oracle.abandon();

        vm.warp(block.timestamp + RULING_DEADLINE);
        oracle.abandon();

        assertEq(bondAsset.balanceOf(alice), aliceBefore + BOND, "the proposer's bond was not returned");
        assertEq(bondAsset.balanceOf(mallory), malloryBefore + BOND, "the challenger's bond was not returned");

        // And the question stays unanswerable, so the round it settles voids
        // and refunds rather than paying a side nobody stood behind.
        (bool ok,) = oracle.readAt(0, block.timestamp);
        assertFalse(ok, "an abandoned question answered anyway");

        vm.prank(committee);
        vm.expectRevert(abi.encodeWithSelector(EventRoundOracle.WrongState.selector, EventRoundOracle.State.Abandoned));
        oracle.rule(EventRoundOracle.Outcome.Yes, "ipfs://late");
    }

    // ------------------------------------------------------------------
    // A proposer with a position
    // ------------------------------------------------------------------

    /// @dev Decided deliberately rather than by omission: holding a position
    /// is allowed and recorded. A ban cannot work — the banned holder proposes
    /// from an address holding nothing — so what is offered instead is
    /// disclosure plus a window anybody can be paid to argue in.
    function test_aProposerWithAPositionIsAllowedAndRecorded() public {
        StubMarket stub = new StubMarket(mallory, 1_234e6);
        vm.prank(owner);
        oracle.setMarket(address(stub), 1);

        _propose(mallory, EventRoundOracle.Outcome.Yes);

        assertEq(oracle.proposerStake(), 1_234e6, "the proposer's interest was not recorded");
        assertEq(uint256(oracle.state()), uint256(EventRoundOracle.State.Proposed), "a holder was blocked");
    }

    /// @dev The disclosure must never become a way to block a proposal: a
    /// market that reverts on every read would otherwise freeze the question.
    function test_aMarketThatRevertsDoesNotStopAClaim() public {
        RevertingMarket bad = new RevertingMarket();
        vm.prank(owner);
        oracle.setMarket(address(bad), 1);

        _propose(alice, EventRoundOracle.Outcome.Yes);

        assertEq(oracle.proposerStake(), 0, "a failed read has to record zero, not guess");
        assertEq(uint256(oracle.state()), uint256(EventRoundOracle.State.Proposed));
    }

    // ------------------------------------------------------------------
    // Shape
    // ------------------------------------------------------------------

    function test_theConstructorRefusesAQuestionNobodyCouldArgueWith() public {
        // A zero bond makes challenging pointless; a zero window makes the
        // claim final on arrival, which is the operator call this replaces.
        vm.expectRevert(EventRoundOracle.InvalidParameters.selector);
        new EventRoundOracle(
            owner,
            committee,
            IERC20(address(bondAsset)),
            0,
            EVENT_TIME,
            CHALLENGE_WINDOW,
            RULING_DEADLINE,
            "q",
            "ipfs://c",
            CRITERIA
        );

        vm.expectRevert(EventRoundOracle.InvalidParameters.selector);
        new EventRoundOracle(
            owner,
            committee,
            IERC20(address(bondAsset)),
            BOND,
            EVENT_TIME,
            0,
            RULING_DEADLINE,
            "q",
            "ipfs://c",
            CRITERIA
        );

        // And criteria nobody can check.
        vm.expectRevert(EventRoundOracle.InvalidParameters.selector);
        new EventRoundOracle(
            owner,
            committee,
            IERC20(address(bondAsset)),
            BOND,
            EVENT_TIME,
            CHALLENGE_WINDOW,
            RULING_DEADLINE,
            "q",
            "ipfs://c",
            bytes32(0)
        );
    }

    function test_theStrikeSitsBetweenTheTwoAnswers() public view {
        // The whole mapping onto ParimutuelRound's price comparison. If these
        // ever stop bracketing the strike, a settled question pays the wrong
        // side — silently, because the round is only comparing numbers.
        assertLt(oracle.NO(), oracle.STRIKE());
        assertGt(oracle.YES(), oracle.STRIKE());

        (bool ok, uint256 price,) = oracle.readLatest();
        assertTrue(ok);
        assertEq(price, oracle.STRIKE(), "a round opened from this oracle must strike at the sentinel");
    }

    function test_aQuestionIsAnsweredOnce() public {
        _propose(alice, EventRoundOracle.Outcome.Yes);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        oracle.finalise();

        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(EventRoundOracle.WrongState.selector, EventRoundOracle.State.Final));
        oracle.propose(EventRoundOracle.Outcome.No, "ipfs://other", keccak256("y"));

        vm.expectRevert(abi.encodeWithSelector(EventRoundOracle.WrongState.selector, EventRoundOracle.State.Final));
        oracle.finalise();
    }
}

/// @dev A market that reports a fixed stake for one address.
contract StubMarket {
    address private immutable holder;
    uint256 private immutable amount;

    constructor(address holder_, uint256 amount_) {
        holder = holder_;
        amount = amount_;
    }

    function roundCount() external pure returns (uint256) {
        return 1;
    }

    function stakeOf(uint256, address account, uint8 side) external view returns (uint256) {
        return account == holder && side == 0 ? amount : 0;
    }
}

/// @dev A market that answers nothing, which must not be able to block a claim.
contract RevertingMarket {
    fallback() external {
        revert("no");
    }
}
