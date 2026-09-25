// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IRoundOracle } from "./ParimutuelRound.sol";

/// @notice An outcome for a question no price feed can answer — "Brazil win
/// the 2026 World Cup" — as a bonded claim with a challenge window (GHO-80).
///
/// # Why this is not an oracle read
///
/// A price market needs no proof of validity. The feed published a number,
/// `ChainlinkRoundOracle` read it at a named feed round, and anyone can check
/// the feed themselves. An external question has no such source: somebody has
/// to say what happened, and the whole problem is what stops them lying —
/// including when they hold a position in the market they are resolving.
///
/// So the answer here is not a reading. It is a **claim, bonded, against
/// named evidence, that becomes true only if nobody pays to argue**:
///
///   1. PROPOSE   anyone posts an outcome with a bond, a source URI, and a
///                digest of the document it resolves against.
///   2. CHALLENGE anyone can match that bond inside the window. Nobody does,
///                and it settles — the proposer takes their bond back.
///   3. RULE      a challenged claim is decided by the arbiter. The wrong
///                side's bond goes to the right side.
///
/// The window is the product. It is the difference between "we say Brazil
/// lost" and "anyone could have proved otherwise, it cost them nothing to
/// look, and nobody did".
///
/// # What the arbiter is
///
/// An address, deliberately. Behind it today is a 3-of-5 committee of named
/// signers (a multisig); behind it tomorrow could be a different committee, a
/// court of a different shape, or something trustless. Making it an address
/// rather than a signer set in here means replacing it never touches the
/// market, the round, or anybody's position. The trust assumption is then one
/// address a reader can look up, rather than a mechanism buried in bytecode.
///
/// # How an outcome becomes something `ParimutuelRound` can settle
///
/// `IRoundOracle` is price-shaped, because it was built for price feeds, and
/// a round settles by comparing a close price against its strike. An outcome
/// is mapped onto that comparison rather than changing it:
///
///   strike (set when the round opens)   1e18
///   Yes                                 2e18   — above the strike, Up wins
///   No                                  0      — below the strike, Down wins
///
/// Up and Down are what the round's pools are called; Yes and No are what
/// they mean here, and what the app shows (GHO-78). Nothing in the round
/// changes, which is the point: the settlement path, the rake, the void rules
/// and the claim maths are the ones already audited and already live.
///
/// # What it refuses to answer
///
/// `ok == false` until an outcome is final, and forever if the question was
/// abandoned. A round whose oracle never answers cannot resolve, which leaves
/// the owner's `voidUnsettledRound` — a full refund of every stake — as the
/// terminal state. That is the correct outcome for a question nobody would
/// stand behind: no winner is paid on an answer nobody was willing to bond.
contract EventRoundOracle is IRoundOracle, Ownable {
    using SafeERC20 for IERC20;

    /// @dev The strike an event round must be opened with, and the two values
    /// `readAt` answers with. Public so a deployer, a keeper and a test all
    /// read the same constants rather than three copies of 1e18.
    uint256 public constant STRIKE = 1e18;
    uint256 public constant YES = 2e18;
    uint256 public constant NO = 0;

    enum Outcome {
        None,
        Yes,
        No
    }

    enum State {
        /// @dev Nothing proposed yet, or a challenge was abandoned back to
        /// square one is *not* a thing — see `abandon`.
        Open,
        Proposed,
        Challenged,
        Final,
        /// @dev Terminal and unanswerable: the arbiter did not rule in time.
        Abandoned
    }

    /// @notice The question, in the words it will be judged by.
    string public question;

    /// @notice Where the resolution criteria live, and the digest of that
    /// document.
    ///
    /// @dev Both, because either alone is weak: a URI can be edited after the
    /// fact, and a digest nobody can fetch proves nothing. Together they say
    /// "this document, unchanged, is what this question means" — and a reader
    /// who finds the URI serving something else has caught it.
    string public criteriaURI;
    bytes32 public immutable criteriaDigest;

    /// @notice Nothing may be proposed before this. The event has to have
    /// happened.
    uint64 public immutable eventTime;

    /// @notice How long a proposal can be challenged for.
    uint64 public immutable challengeWindow;

    /// @notice How long the arbiter has to rule on a challenge before the
    /// question is abandoned and both bonds are returned.
    uint64 public immutable rulingDeadline;

    /// @notice What a proposal and a challenge each cost.
    ///
    /// @dev Per question, not global, and the reasoning is worth stating
    /// because a guessed constant here is the whole security of the thing.
    ///
    /// What the bond has to do is make **challenging worth it**. A challenger
    /// who is right takes the liar's bond, so their profit is exactly `bond`
    /// for the work of reading the evidence and sending one transaction —
    /// minutes, and cents of gas on an L2. Anything from a few tens of
    /// dollars upwards clears that by orders of magnitude, and the window is
    /// short enough that the locked capital costs nothing to speak of.
    ///
    /// What the bond **cannot** do, and it is dishonest to imply otherwise:
    /// bound the liar's upside. Someone holding a large position can lie for
    /// the price of one bond, and no bond small enough for an honest reporter
    /// to post is large enough to price that out. What actually protects a
    /// valuable market is that the people on the other side of it lose more
    /// than the bond if the lie stands, so they are the ones motivated to
    /// challenge — and challenging is open to them, profitable, and takes one
    /// transaction.
    ///
    /// That is why this is set per question rather than once for the
    /// protocol: a question settling a large market can be deployed with a
    /// bond sized to it, and a small one is not priced out of existence by a
    /// bond chosen for somebody else's market.
    IERC20 public immutable bondAsset;
    uint256 public immutable bond;

    /// @notice Who decides a challenged claim. Replaceable, and that is the
    /// whole design — see the contract note.
    address public arbiter;

    State public state;
    Outcome public outcome;

    address public proposer;
    address public challenger;
    uint64 public proposedAt;
    uint64 public challengedAt;
    Outcome public proposedOutcome;
    string public evidenceURI;
    bytes32 public evidenceDigest;

    /// @notice The proposer's stake in the market this question settles, at
    /// the moment they proposed, or zero if no market was named.
    ///
    /// @dev Recorded rather than forbidden. See `propose`.
    uint256 public proposerStake;

    /// @notice The market and round whose positions a proposer's interest is
    /// read from. Optional: a question can exist before the market that uses
    /// it, and a question settling no market discloses nothing.
    ///
    /// @dev One round, not a market-wide sweep. A question has one answer, so
    /// it settles one round — and reading every round of a market would put
    /// an unbounded loop of external calls inside `propose`, where the cost
    /// lands on whoever is trying to report the truth.
    address public market;
    uint256 public marketRoundId;

    event Proposed(
        address indexed proposer,
        Outcome outcome,
        string evidenceURI,
        bytes32 evidenceDigest,
        uint256 proposerStake,
        uint64 challengeClosesAt
    );
    event Challenged(address indexed challenger, uint64 rulingDueAt);
    event Ruled(address indexed arbiter, Outcome outcome, address paid, string reasonURI);
    event Finalised(Outcome outcome);
    event Abandoned(uint64 at);
    event ArbiterSet(address indexed previous, address indexed next);
    event MarketSet(address indexed market, uint256 roundId);

    error WrongState(State state);
    error TooEarly(uint64 until);
    error NotYet(uint64 until);
    error NotArbiter(address caller);
    error NotAnOutcome();
    error ZeroAddress();
    error InvalidParameters();

    constructor(
        address initialOwner,
        address arbiter_,
        IERC20 bondAsset_,
        uint256 bond_,
        uint64 eventTime_,
        uint64 challengeWindow_,
        uint64 rulingDeadline_,
        string memory question_,
        string memory criteriaURI_,
        bytes32 criteriaDigest_
    ) Ownable(initialOwner) {
        if (arbiter_ == address(0) || address(bondAsset_) == address(0)) revert ZeroAddress();
        // A zero bond makes proposing free, which makes challenging pointless:
        // there is nothing to win and nothing to lose. A zero window makes a
        // claim final the moment it is made, which is the operator call this
        // exists to replace. A zero digest would let the criteria be rewritten
        // after the fact.
        if (bond_ == 0 || challengeWindow_ == 0 || rulingDeadline_ == 0) revert InvalidParameters();
        if (criteriaDigest_ == bytes32(0) || bytes(question_).length == 0) revert InvalidParameters();

        arbiter = arbiter_;
        bondAsset = bondAsset_;
        bond = bond_;
        eventTime = eventTime_;
        challengeWindow = challengeWindow_;
        rulingDeadline = rulingDeadline_;
        question = question_;
        criteriaURI = criteriaURI_;
        criteriaDigest = criteriaDigest_;

        emit ArbiterSet(address(0), arbiter_);
    }

    // ------------------------------------------------------------------
    // IRoundOracle
    // ------------------------------------------------------------------

    /// @inheritdoc IRoundOracle
    ///
    /// @dev The strike an event round opens at. There is no "price now" for a
    /// question, so this answers the sentinel the outcome is compared against
    /// — which is what a keeper opening the round needs, and nothing else.
    function readLatest() external pure returns (bool ok, uint256 price, uint80 oracleRoundId) {
        return (true, STRIKE, 0);
    }

    /// @inheritdoc IRoundOracle
    ///
    /// @dev `oracleRoundId` is ignored: it exists so a price adapter can be
    /// pinned to one feed round, and a question has exactly one answer rather
    /// than a series. `at` is ignored for the same reason — the outcome is of
    /// the event, not of an instant.
    ///
    /// Answers only when final. A round asking early gets `ok == false` and
    /// waits, which is the same handling as a feed that has not published.
    function readAt(uint80, uint256) external view returns (bool ok, uint256 price) {
        if (state != State.Final) return (false, 0);
        return (true, outcome == Outcome.Yes ? YES : NO);
    }

    // ------------------------------------------------------------------
    // The claim
    // ------------------------------------------------------------------

    /// @notice Claim an outcome, backed by a bond and named evidence.
    ///
    /// @dev Permissionless on purpose. The protection is not who may propose
    /// — it is that anyone may argue, and that being wrong costs the bond.
    ///
    /// **A proposer holding a position is allowed, and recorded.** It is the
    /// obvious attack and it is not settled by omission: forbidding it cannot
    /// work. A banned holder proposes from an address that holds nothing
    /// while their real position sits elsewhere, so the ban stops nobody who
    /// is trying, and does stop the most motivated honest proposers — the
    /// people who actually care what happened. What works instead is that the
    /// claim is public for the whole window, the proposer's own stake is
    /// recorded beside it, and anyone who disagrees is paid to say so.
    function propose(Outcome outcome_, string calldata evidenceURI_, bytes32 evidenceDigest_) external {
        if (state != State.Open) revert WrongState(state);
        if (outcome_ == Outcome.None) revert NotAnOutcome();
        if (block.timestamp < eventTime) revert TooEarly(eventTime);
        if (evidenceDigest_ == bytes32(0)) revert InvalidParameters();

        proposer = msg.sender;
        proposedOutcome = outcome_;
        evidenceURI = evidenceURI_;
        evidenceDigest = evidenceDigest_;
        proposedAt = uint64(block.timestamp);
        proposerStake = _stakeOf(msg.sender);
        state = State.Proposed;

        bondAsset.safeTransferFrom(msg.sender, address(this), bond);

        emit Proposed(
            msg.sender,
            outcome_,
            evidenceURI_,
            evidenceDigest_,
            proposerStake,
            uint64(block.timestamp) + challengeWindow
        );
    }

    /// @notice Match the bond and send the claim to the arbiter.
    ///
    /// @dev The challenger does not state a counter-outcome. There are two
    /// answers, so disagreeing with one names the other — and asking for it
    /// would let a challenger with a third opinion produce a claim the round
    /// cannot settle.
    function challenge() external {
        if (state != State.Proposed) revert WrongState(state);
        uint64 closesAt = proposedAt + challengeWindow;
        if (block.timestamp >= closesAt) revert NotYet(closesAt);

        challenger = msg.sender;
        challengedAt = uint64(block.timestamp);
        state = State.Challenged;

        bondAsset.safeTransferFrom(msg.sender, address(this), bond);

        emit Challenged(msg.sender, uint64(block.timestamp) + rulingDeadline);
    }

    /// @notice Settle an unchallenged claim. Permissionless: it is the
    /// passage of time that decides this, not anybody's say-so.
    function finalise() external {
        if (state != State.Proposed) revert WrongState(state);
        uint64 closesAt = proposedAt + challengeWindow;
        if (block.timestamp < closesAt) revert NotYet(closesAt);

        outcome = proposedOutcome;
        state = State.Final;

        bondAsset.safeTransfer(proposer, bond);

        emit Finalised(outcome);
    }

    /// @notice Decide a challenged claim.
    ///
    /// @param outcome_ What actually happened, which may or may not be what
    /// was proposed.
    /// @param reasonURI Where the ruling and its reasoning are published.
    ///
    /// @dev The loser's bond goes to the winner, which is what makes a
    /// challenge worth making and a false claim worth not making. The arbiter
    /// takes nothing: paying the judge out of the disputed pot is how a judge
    /// acquires an interest in disputes.
    function rule(Outcome outcome_, string calldata reasonURI) external {
        if (msg.sender != arbiter) revert NotArbiter(msg.sender);
        if (state != State.Challenged) revert WrongState(state);
        if (outcome_ == Outcome.None) revert NotAnOutcome();

        outcome = outcome_;
        state = State.Final;

        address paid = outcome_ == proposedOutcome ? proposer : challenger;
        bondAsset.safeTransfer(paid, bond * 2);

        emit Ruled(msg.sender, outcome_, paid, reasonURI);
        emit Finalised(outcome_);
    }

    /// @notice Give up on a challenge the arbiter never ruled on, returning
    /// both bonds.
    ///
    /// @dev The committee not answering is a real state and it needs a
    /// terminal one, or the bonds are locked forever and the round with them.
    /// Both sides get their money back: neither was shown to be wrong, and
    /// paying one of them would be the ruling nobody made.
    ///
    /// The question is then unanswerable — `readAt` stays `false` — so the
    /// round it was settling voids and refunds every stake. A question the
    /// process could not answer pays nobody, which is the only outcome that
    /// cannot be gamed by a committee that stays silent on purpose.
    function abandon() external {
        if (state != State.Challenged) revert WrongState(state);
        uint64 dueAt = challengedAt + rulingDeadline;
        if (block.timestamp < dueAt) revert NotYet(dueAt);

        state = State.Abandoned;

        bondAsset.safeTransfer(proposer, bond);
        bondAsset.safeTransfer(challenger, bond);

        emit Abandoned(uint64(block.timestamp));
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    /// @notice Replace the arbiter.
    ///
    /// @dev Allowed while a challenge is open, and deliberately so: a
    /// committee that has lost its keys or its quorum is exactly when this is
    /// needed, and the alternative is waiting out `rulingDeadline` and
    /// abandoning a question somebody could still answer. The owner cannot
    /// decide an outcome, cannot touch a bond, and cannot reach a claim that
    /// is already final.
    function setArbiter(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        if (state == State.Final || state == State.Abandoned) revert WrongState(state);

        emit ArbiterSet(arbiter, next);
        arbiter = next;
    }

    /// @notice Name the market and round whose positions a proposer's
    /// interest is read from. Settable once, before anything is proposed.
    ///
    /// @dev Not a constructor argument because the market is deployed against
    /// *this* address — the oracle has to exist first. Frozen after a
    /// proposal so the recorded interest cannot be made to mean something
    /// else afterwards.
    function setMarket(address market_, uint256 roundId_) external onlyOwner {
        if (market_ == address(0)) revert ZeroAddress();
        if (roundId_ == 0) revert InvalidParameters();
        if (state != State.Open || market != address(0)) revert WrongState(state);

        market = market_;
        marketRoundId = roundId_;
        emit MarketSet(market_, roundId_);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice When the challenge window closes, or zero if nothing is
    /// proposed.
    function challengeClosesAt() external view returns (uint64) {
        return state == State.Proposed ? proposedAt + challengeWindow : 0;
    }

    /// @notice When the arbiter's ruling is due, or zero if nothing is
    /// challenged.
    function rulingDueAt() external view returns (uint64) {
        return state == State.Challenged ? challengedAt + rulingDeadline : 0;
    }

    /// @dev What `account` has riding on the round this question settles:
    /// both sides, because holding either is an interest in the answer.
    ///
    /// Two calls, fixed. Best effort by construction: it reads a contract
    /// this one does not control, so a market that reverts or answers
    /// strangely must not be able to stop a proposal. It records zero and the
    /// claim proceeds — the number is disclosure, not a gate, and a gate that
    /// an unrelated contract can close is a denial of service on the truth.
    ///
    /// A raw `staticcall` rather than a typed one for exactly that reason: a
    /// typed call to a contract that answers differently reverts, and this
    /// must not.
    function _stakeOf(address account) private view returns (uint256) {
        if (market == address(0)) return 0;
        return _stakeOfSide(account, 0) + _stakeOfSide(account, 1);
    }

    function _stakeOfSide(address account, uint8 side) private view returns (uint256) {
        (bool ok, bytes memory data) = market.staticcall(
            abi.encodeWithSignature("stakeOf(uint256,address,uint8)", marketRoundId, account, side)
        );
        if (!ok || data.length != 32) return 0;
        return abi.decode(data, (uint256));
    }
}
