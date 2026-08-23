// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The price source a round settles against. Deliberately narrow: it
/// answers "can this reading be trusted, and what is it," and nothing else.
///
/// Everything feed-specific — Chainlink staleness against the heartbeat, the
/// L2 sequencer uptime feed and its post-recovery grace period, and a Stock
/// Token market's advisory `oraclePaused()` — lives behind `ok == false` in
/// the adapter (GHO-14). This contract only decides what to *do* about an
/// untrustworthy reading, which is always the same thing: void the round.
///
/// `oracleRoundId` is surfaced because ordering is a round-level property,
/// not a feed-level one: the resolve read must come from a strictly later
/// feed round than the lock read, and only the round knows what the lock
/// read was.
///
/// The two reads are deliberately different in kind. `readLatest` answers
/// "what is the price now," which is what a strike needs. `readAt` answers
/// "what was the price at this instant," pinned to a specific feed round the
/// caller names and the adapter verifies — which is what a *settlement*
/// needs, because a settlement whose price depends on when someone chose to
/// send the transaction is a settlement they can choose.
interface IRoundOracle {
    function readLatest() external view returns (bool ok, uint256 price, uint80 oracleRoundId);

    /// @param oracleRoundId The feed round the caller claims is the last one
    /// published at or before `at`. The adapter verifies that claim; it does
    /// not take the caller's word for it.
    function readAt(uint80 oracleRoundId, uint256 at) external view returns (bool ok, uint256 price);
}

/// @notice Where a position's proceeds go when it was not funded from the
/// holder's own wallet. Implemented on the lending side by GHO-15, so that a
/// refund or a payout on borrowed funds repays the debt it came from instead
/// of landing in the user's wallet with the loan left dangling.
///
/// The round transfers the tokens first, then calls this — push, then notify.
interface ISettlementSink {
    function onPositionSettled(address user, uint256 amount) external;
}

/// @notice A binary, parimutuel prediction round. Stakes go into one pool per
/// side, the protocol takes a rake off the top, and the winning side splits
/// what's left in proportion to what each of them put in.
///
/// # Parimutuel, not an order book
///
/// Nobody quotes odds and nobody takes the other side of your bet — the other
/// bettors are the other side. That means the protocol carries **no
/// directional risk at all**: it pays out exactly what it took in, minus the
/// rake, whichever way the price goes. There is no liability to hedge, no
/// market maker to fund, and no scenario where the house loses. That property
/// is the reason this design was chosen, and it is why the void rules below
/// never top up a thin side from protocol funds — doing so would make the
/// protocol a participant in its own market.
///
/// # Odds are derived, never set
///
///   multiple = (totalPool - rake) / sidePool
///
/// During OPEN this number moves with every entry, so anything the UI shows
/// is provisional by construction. It is final only at lock.
///
/// # The four phases, and why entry must close before the strike is known
///
///   OPEN         entry window. No strike price exists yet.
///   CUTOFF       last `entryCutoff` seconds before lockTime. Entry refused.
///   OBSERVATION  `lockRound()` has captured `lockPrice`. No entry, no exit,
///                no changing sides.
///   RESOLVED     `resolveRound()` captured `closePrice` and set the outcome.
///
/// If entry stayed open until the strike were known, anyone could watch the
/// price move and enter on the side that had already won. The cutoff buffer
/// closes the narrower version of the same hole: without it, a bot watching
/// the mempool could see the pending `lockRound()` transaction, read the
/// price it is about to capture, and enter in the block before it lands.
///
/// # Void: refund everyone, take no rake
///
/// A round that cannot be settled honestly is unwound rather than guessed at.
/// See `_void` for the trigger list. Void takes no rake — the protocol does
/// not get paid for a round it failed to run.
///
/// # Claims are pull, not push
///
/// Resolution is O(1) and touches no per-user state; each winner pulls their
/// own payout. Pushing to a list of winners would put an unbounded loop on
/// the resolution path, which is how prediction markets brick themselves the
/// moment a round gets popular.
contract ParimutuelRound is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Ratio precision. 1e18 = 100%.
    uint256 public constant WAD = 1e18;

    /// @dev Ceiling on the rake, as a deployment guard. A rake this large is
    /// already indefensible; anything above it is a fat finger.
    uint256 public constant MAX_RAKE = 1e17; // 10%

    enum Side {
        Up,
        Down
    }

    /// @dev Storage state. The observation window is time-derived rather than
    /// stored — see `phaseOf`.
    enum Status {
        None,
        Open,
        Locked,
        Resolved,
        Void
    }

    /// @dev What a round looks like from outside, including the two phases
    /// that are functions of the clock rather than of storage.
    enum Phase {
        None,
        Open,
        Cutoff,
        Observation,
        Resolved,
        Void
    }

    /// @notice The three timing parameters, grouped so they cannot be
    /// transposed at deployment. Three adjacent `uint64` durations as
    /// positional arguments is the same silent-swap hazard `RiskParams`
    /// exists to prevent in CollateralVault — and swapping a 60-second lock
    /// window with a one-hour resolve deadline would be invisible until a
    /// round settled on a strike someone picked.
    struct Timing {
        /// @dev Entry stops this long before `lockTime`.
        uint64 entryCutoff;
        /// @dev A lock landing later than this past `lockTime` voids.
        uint64 lockWindow;
        /// @dev How long to wait for a usable feed round before voiding.
        uint64 resolveDeadline;
    }

    struct Round {
        uint64 openTime;
        uint64 lockTime;
        uint64 closeTime;
        Status status;
        /// @dev Meaningful only once `status == Resolved`.
        Side winner;
        uint256 lockPrice;
        uint256 closePrice;
        /// @dev Feed round the lock price came from. The resolve read must be
        /// strictly later than this.
        uint80 lockOracleRoundId;
        uint256 upPool;
        uint256 downPool;
        /// @dev Taken off the total at resolution. Always zero on a void.
        uint256 rakeTaken;
    }

    IERC20 public immutable stakeAsset;
    IRoundOracle public immutable oracle;

    /// @dev Protocol's cut of a resolved round.
    uint256 public immutable rake;

    /// @dev Entry is refused this many seconds before `lockTime`, so a
    /// pending lock transaction cannot be front-run.
    uint64 public immutable entryCutoff;

    /// @dev How late a lock may land before the round voids instead.
    ///
    /// The strike is read as "the price now", so a caller who shows up late
    /// is choosing it — a Down bettor would wait for a local high. Nothing
    /// pins a strike the way `readAt` pins a settlement (there is no "next"
    /// feed round to bound it against yet at lock time), so the discretion is
    /// bounded by keeping this window tight instead. Seconds, not minutes.
    uint64 public immutable lockWindow;

    /// @dev How long a locked round may go unsettled before the owner may
    /// unwind it (`voidUnsettledRound`).
    ///
    /// This one is about liveness, not discretion: resolution is pinned to a
    /// feed round, so it produces the same answer whenever it happens and a
    /// late caller gains nothing. What it cannot survive is a feed that never
    /// publishes a usable round at all, and this is how long we wait before
    /// calling that. Generous on purpose — voiding a round that could have
    /// been settled correctly helps nobody.
    uint64 public immutable resolveDeadline;

    /// @dev Least a side may hold at lock time for the round to be valid.
    /// A one-sided pool is not a market: the sole side would take the whole
    /// pot back minus rake, which is a fee on nothing. Must be non-zero,
    /// which is also what makes the payout division safe.
    uint256 public immutable minSidePool;

    uint256 public roundCount;
    mapping(uint256 => Round) private _rounds;

    /// @dev roundId => user => side => amount staked.
    mapping(uint256 => mapping(address => mapping(Side => uint256))) public stakeOf;
    mapping(uint256 => mapping(address => bool)) public claimed;

    /// @dev Set when a position was opened on a user's behalf by a router
    /// holding borrowed funds. Payouts and refunds for that position route
    /// back through the router instead of to the user.
    mapping(uint256 => mapping(address => ISettlementSink)) public settlementSinkOf;

    /// @dev Contracts allowed to open positions on someone else's behalf.
    /// GHO-15's borrow-to-position path is the intended holder.
    mapping(address => bool) public isRouter;

    /// @dev Rake collected from resolved rounds, awaiting withdrawal.
    uint256 public protocolFees;

    event RoundOpened(uint256 indexed roundId, uint64 openTime, uint64 lockTime, uint64 closeTime);
    event PositionTaken(uint256 indexed roundId, address indexed user, Side side, uint256 amount, address funder);
    event RoundLocked(uint256 indexed roundId, uint256 lockPrice, uint80 oracleRoundId);
    event RoundResolved(uint256 indexed roundId, uint256 closePrice, Side winner, uint256 rakeTaken);
    event RoundVoided(uint256 indexed roundId, string reason);
    event Claimed(uint256 indexed roundId, address indexed user, uint256 amount, address recipient);
    event RouterSet(address indexed router, bool allowed);
    event FeesWithdrawn(address indexed to, uint256 amount);

    error ZeroAmount();
    error ZeroAddress();
    error InvalidSchedule();
    error InvalidParameters();
    error UnknownRound(uint256 roundId);
    error WrongPhase(uint256 roundId, Phase actual);
    error EntryClosed(uint256 roundId, uint64 cutoffAt);
    error TooEarly(uint256 roundId, uint64 notBefore);
    error OracleUnavailable(uint256 roundId);
    error OracleRoundNotAdvanced(uint256 roundId, uint80 lockRoundId, uint80 resolveRoundId);
    error NotRouter(address caller);
    error MixedFunding(uint256 roundId, address user);
    error AlreadyClaimed(uint256 roundId, address user);
    error NothingToClaim(uint256 roundId, address user);
    error InsufficientFees(uint256 requested, uint256 available);

    constructor(
        IERC20 stakeAsset_,
        IRoundOracle oracle_,
        uint256 rake_,
        Timing memory timing,
        uint256 minSidePool_,
        address initialOwner
    ) Ownable(initialOwner) {
        if (address(stakeAsset_) == address(0) || address(oracle_) == address(0)) revert ZeroAddress();
        if (rake_ > MAX_RAKE) revert InvalidParameters();
        // A zero floor would let a round resolve with an empty winning side
        // and divide by zero paying it out; a zero cutoff reopens the
        // lock-transaction front-run; a zero window on either transition
        // means it can only ever land in the exact second it was due.
        if (minSidePool_ == 0 || timing.entryCutoff == 0) revert InvalidParameters();
        if (timing.lockWindow == 0 || timing.resolveDeadline == 0) revert InvalidParameters();

        stakeAsset = stakeAsset_;
        oracle = oracle_;
        rake = rake_;
        entryCutoff = timing.entryCutoff;
        lockWindow = timing.lockWindow;
        resolveDeadline = timing.resolveDeadline;
        minSidePool = minSidePool_;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function rounds(uint256 roundId) external view returns (Round memory) {
        return _rounds[roundId];
    }

    /// @notice The phase as an observer sees it, which is not the same as the
    /// stored status: OPEN becomes CUTOFF on the clock alone, and a locked
    /// round sits in OBSERVATION until someone resolves it.
    function phaseOf(uint256 roundId) public view returns (Phase) {
        Round storage round = _rounds[roundId];
        if (round.status == Status.None) return Phase.None;
        if (round.status == Status.Resolved) return Phase.Resolved;
        if (round.status == Status.Void) return Phase.Void;
        if (round.status == Status.Locked) return Phase.Observation;
        return entryIsOpen(roundId) ? Phase.Open : Phase.Cutoff;
    }

    /// @notice Whether a new position can be taken right now.
    function entryIsOpen(uint256 roundId) public view returns (bool) {
        Round storage round = _rounds[roundId];
        if (round.status != Status.Open) return false;
        return block.timestamp >= round.openTime && block.timestamp < _cutoffAt(round);
    }

    function totalPool(uint256 roundId) public view returns (uint256) {
        Round storage round = _rounds[roundId];
        return round.upPool + round.downPool;
    }

    function poolOf(uint256 roundId, Side side) public view returns (uint256) {
        return side == Side.Up ? _rounds[roundId].upPool : _rounds[roundId].downPool;
    }

    /// @notice What one unit staked on `side` currently returns if that side
    /// wins, WAD-scaled: 2e18 means "doubles your money".
    ///
    /// @dev Provisional until lock — every subsequent entry moves it. Returns
    /// zero for an empty side, which is not an infinite multiple but an
    /// undefined one: a side with nothing in it cannot win a round, because
    /// the minimum-side floor voids that round at lock.
    function oddsOf(uint256 roundId, Side side) external view returns (uint256) {
        uint256 sidePool = poolOf(roundId, side);
        if (sidePool == 0) return 0;
        uint256 pool = totalPool(roundId);
        return Math.mulDiv(pool - Math.mulDiv(pool, rake, WAD), WAD, sidePool);
    }

    /// @notice What `user` can claim from `roundId` right now. Zero while the
    /// round is unresolved, for a losing position, and after claiming.
    function claimableOf(uint256 roundId, address user) public view returns (uint256) {
        if (claimed[roundId][user]) return 0;
        Round storage round = _rounds[roundId];

        if (round.status == Status.Void) {
            return stakeOf[roundId][user][Side.Up] + stakeOf[roundId][user][Side.Down];
        }
        if (round.status != Status.Resolved) return 0;

        uint256 stake = stakeOf[roundId][user][round.winner];
        if (stake == 0) return 0;
        uint256 winningPool = round.winner == Side.Up ? round.upPool : round.downPool;

        // Floor division, so the sum of all payouts can fall a few wei short
        // of the distributable pool. The remainder stays in the contract
        // rather than being handed to the last claimant or swept into fees:
        // rounding dust is bounded by one wei per claimant, and the
        // alternative is a payout that depends on claim order.
        return Math.mulDiv(totalPool(roundId) - round.rakeTaken, stake, winningPool);
    }

    function _cutoffAt(Round storage round) private view returns (uint64) {
        return round.lockTime - entryCutoff;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /// @notice Schedule a round. Owner-gated because the keeper (GHO-24) is
    /// what drives the cadence and rounds are meant to overlap on a fixed
    /// schedule — an open creator would let anyone flood the market with
    /// rounds nobody can be expected to price.
    ///
    /// @dev Every phase boundary is stored as an absolute timestamp rather
    /// than a duration, so a round's schedule cannot shift under it if the
    /// keeper is late calling the transition.
    function openRound(uint64 openTime, uint64 lockTime, uint64 closeTime) external onlyOwner returns (uint256) {
        // The entry window has to outlast the cutoff buffer, or the round
        // opens with entry already closed.
        if (openTime < block.timestamp) revert InvalidSchedule();
        if (lockTime <= openTime + entryCutoff) revert InvalidSchedule();
        if (closeTime <= lockTime) revert InvalidSchedule();

        uint256 roundId = ++roundCount;
        Round storage round = _rounds[roundId];
        round.openTime = openTime;
        round.lockTime = lockTime;
        round.closeTime = closeTime;
        round.status = Status.Open;

        emit RoundOpened(roundId, openTime, lockTime, closeTime);
        return roundId;
    }

    /// @notice Stake on a side with your own funds.
    function takePosition(uint256 roundId, Side side, uint256 amount) external nonReentrant {
        _takePosition(roundId, msg.sender, side, amount, msg.sender, ISettlementSink(address(0)));
    }

    /// @notice Stake on `user`'s behalf with funds this router is holding for
    /// them — the borrow-to-position path. Proceeds route back to the router
    /// so the borrowed funds settle against the debt rather than landing in
    /// the user's wallet.
    function takePositionFor(uint256 roundId, address user, Side side, uint256 amount) external nonReentrant {
        if (!isRouter[msg.sender]) revert NotRouter(msg.sender);
        if (user == address(0)) revert ZeroAddress();
        _takePosition(roundId, user, side, amount, msg.sender, ISettlementSink(msg.sender));
    }

    function _takePosition(
        uint256 roundId,
        address user,
        Side side,
        uint256 amount,
        address payer,
        ISettlementSink sink
    ) private {
        if (amount == 0) revert ZeroAmount();

        Round storage round = _rounds[roundId];
        if (round.status == Status.None) revert UnknownRound(roundId);
        if (round.status != Status.Open) revert WrongPhase(roundId, phaseOf(roundId));
        if (block.timestamp < round.openTime) revert TooEarly(roundId, round.openTime);
        if (block.timestamp >= _cutoffAt(round)) revert EntryClosed(roundId, _cutoffAt(round));

        // One funding source per user per round. Mixing own and borrowed
        // funds would make a single claim owe part to the user and part to
        // the lender, and there is no split this contract could infer that
        // wouldn't be a guess.
        ISettlementSink existing = settlementSinkOf[roundId][user];
        bool hasStake = stakeOf[roundId][user][Side.Up] + stakeOf[roundId][user][Side.Down] != 0;
        if (hasStake && existing != sink) revert MixedFunding(roundId, user);
        if (address(sink) != address(0) && !hasStake) settlementSinkOf[roundId][user] = sink;

        // Multiple entries on one side simply sum; entries on both sides are
        // allowed and left to be self-punishing — a hedged position pays the
        // rake on the losing half for nothing, which is discouragement enough
        // without spending code on a ban.
        stakeOf[roundId][user][side] += amount;
        if (side == Side.Up) {
            round.upPool += amount;
        } else {
            round.downPool += amount;
        }

        stakeAsset.safeTransferFrom(payer, address(this), amount);

        emit PositionTaken(roundId, user, side, amount, payer);
    }

    /// @notice Capture the strike price and close entry permanently.
    /// Permissionless: the keeper is expected to call it on schedule, but
    /// nothing about it needs privilege, and a round that only a keeper can
    /// advance is a round that stalls when the keeper is down.
    function lockRound(uint256 roundId) external nonReentrant {
        Round storage round = _rounds[roundId];
        if (round.status == Status.None) revert UnknownRound(roundId);
        if (round.status != Status.Open) revert WrongPhase(roundId, phaseOf(roundId));
        if (block.timestamp < round.lockTime) revert TooEarly(roundId, round.lockTime);

        // A side that never filled means there is no market to settle, and
        // this is checked before the oracle so a thin round voids for the
        // honest reason rather than an incidental one.
        if (round.upPool < minSidePool || round.downPool < minSidePool) {
            _void(roundId, round, "side below floor");
            return;
        }

        // A lock is only valid inside its window. The strike is read as "the
        // price now", so a caller who shows up late is choosing it — they can
        // see the feed and wait for a level that suits their side. The window
        // is exactly how much lateness is tolerated; beyond it the round is
        // unwound rather than settled on a number someone picked.
        if (block.timestamp > round.lockTime + lockWindow) {
            _void(roundId, round, "lock window missed");
            return;
        }

        (bool ok, uint256 price, uint80 oracleRoundId) = oracle.readLatest();
        // Inside the window a bad reading is a hiccup, not a verdict: revert
        // so it can be retried on the next block.
        if (!ok) revert OracleUnavailable(roundId);

        round.status = Status.Locked;
        round.lockPrice = price;
        round.lockOracleRoundId = oracleRoundId;

        emit RoundLocked(roundId, price, oracleRoundId);
    }

    /// @notice Settle the outcome against the price at `closeTime`.
    /// Permissionless, for the same reason as `lockRound`.
    ///
    /// @param closeOracleRoundId The feed round the caller claims is the last
    /// one published at or before this round's `closeTime`. It is not taken
    /// on trust: the adapter checks that round's timestamp *and* its
    /// successor's, so exactly one feed round can satisfy it.
    ///
    /// @dev Passing the round in — rather than reading `latestRoundData()` —
    /// is what makes settlement independent of when the transaction lands.
    /// Reading "now" would hand the closing price to whoever sends it: a
    /// losing participant does nothing at `closeTime`, watches the feed, and
    /// resolves the moment the price crosses back over `lockPrice`. Pinning
    /// the read means calling early, on time or an hour late all produce the
    /// same answer, so there is nothing to wait for.
    function resolveRound(uint256 roundId, uint80 closeOracleRoundId) external nonReentrant {
        Round storage round = _rounds[roundId];
        if (round.status == Status.None) revert UnknownRound(roundId);
        if (round.status != Status.Locked) revert WrongPhase(roundId, phaseOf(roundId));
        if (block.timestamp < round.closeTime) revert TooEarly(roundId, round.closeTime);

        // The feed must have moved on since the lock read. Two prices from
        // one feed round are the same observation, and settling on it would
        // report a difference of exactly zero produced by the feed being
        // slow rather than by the market doing anything.
        if (closeOracleRoundId <= round.lockOracleRoundId) {
            revert OracleRoundNotAdvanced(roundId, round.lockOracleRoundId, closeOracleRoundId);
        }

        // No usable feed round at `closeTime` — either none published yet, or
        // the one named is not the last one before it. Always a revert, never
        // a void: see `voidUnsettledRound` for why the liveness escape cannot
        // live on this path.
        (bool ok, uint256 price) = oracle.readAt(closeOracleRoundId, round.closeTime);
        if (!ok) revert OracleUnavailable(roundId);

        // An exact tie is nobody's win. Paying it to one side would be a coin
        // flip decided by whoever wrote the comparison; splitting it across
        // both sides would just be the rake charged for nothing happening.
        if (price == round.lockPrice) {
            round.closePrice = price;
            _void(roundId, round, "tie");
            return;
        }

        uint256 pool = round.upPool + round.downPool;
        uint256 rakeTaken = Math.mulDiv(pool, rake, WAD);

        round.status = Status.Resolved;
        round.closePrice = price;
        round.winner = price > round.lockPrice ? Side.Up : Side.Down;
        round.rakeTaken = rakeTaken;
        protocolFees += rakeTaken;

        emit RoundResolved(roundId, price, round.winner, rakeTaken);
    }

    /// @notice Unwind a locked round that could not be settled. Owner-gated,
    /// and the only privileged action in the lifecycle.
    ///
    /// @dev The one place where an automatic rule cannot work. "No usable
    /// feed round exists at `closeTime`" is a claim about something *not*
    /// existing, and this contract can only ever be shown a round id — so a
    /// version that voided whenever `readAt` said no would let a losing
    /// participant wait out the deadline, pass a deliberately wrong id, and
    /// convert their loss into a refund. `resolveRound` therefore never
    /// voids for unavailability; it reverts, however late it is called, and
    /// the escape hatch is a deliberate act instead.
    ///
    /// What this power actually is: after the deadline, the owner can refund
    /// everyone in a round nobody managed to settle. It cannot pay anyone,
    /// cannot pick a winner, and cannot touch a round that is still
    /// settleable by anyone else — resolution stays open to all comers the
    /// whole time, so the honest path is always available first.
    function voidUnsettledRound(uint256 roundId) external onlyOwner nonReentrant {
        Round storage round = _rounds[roundId];
        if (round.status == Status.None) revert UnknownRound(roundId);
        if (round.status != Status.Locked) revert WrongPhase(roundId, phaseOf(roundId));

        uint64 deadline = round.closeTime + resolveDeadline;
        if (block.timestamp <= deadline) revert TooEarly(roundId, deadline + 1);

        _void(roundId, round, "unsettled past deadline");
    }

    /// @notice Unwind a round that was never locked. `lockRound` voids a
    /// missed window itself, so this is not the usual path — it exists for
    /// the case that one cannot cover: an adapter that *reverts* on read
    /// rather than returning `ok == false`. That would make `lockRound`
    /// revert every time and strand the stakes permanently.
    ///
    /// @dev This one never touches the oracle, which is the whole point.
    /// It stays permissionless because the condition leaves nothing to
    /// judgement: past `lockTime + lockWindow` no lock can succeed anyway, so
    /// this only names what is already true. The locked-round equivalent,
    /// `voidUnsettledRound`, cannot make that claim and is owner-gated for
    /// exactly that reason.
    function voidUnlockedRound(uint256 roundId) external nonReentrant {
        Round storage round = _rounds[roundId];
        if (round.status == Status.None) revert UnknownRound(roundId);
        if (round.status != Status.Open) revert WrongPhase(roundId, phaseOf(roundId));

        uint64 deadline = round.lockTime + lockWindow;
        if (block.timestamp <= deadline) revert TooEarly(roundId, deadline + 1);

        _void(roundId, round, "never locked");
    }

    /// @dev Voiding is only a status change: every stake is already recorded
    /// per user, so refunds fall out of `claimableOf` with no loop and no
    /// per-user write. No rake is taken — the protocol is not paid for a
    /// round it could not run.
    function _void(uint256 roundId, Round storage round, string memory reason) private {
        round.status = Status.Void;
        emit RoundVoided(roundId, reason);
    }

    // ------------------------------------------------------------------
    // Claims
    // ------------------------------------------------------------------

    /// @notice Collect a payout or a refund. Callable by anyone on anyone's
    /// behalf — the funds go to the position holder (or their settlement
    /// sink) regardless of who pays the gas, so a keeper can sweep claims for
    /// users without being able to redirect a wei of it.
    function claim(uint256 roundId, address user) external nonReentrant returns (uint256) {
        if (_rounds[roundId].status == Status.None) revert UnknownRound(roundId);
        if (claimed[roundId][user]) revert AlreadyClaimed(roundId, user);

        uint256 amount = claimableOf(roundId, user);
        if (amount == 0) revert NothingToClaim(roundId, user);

        // Set before paying: the flag is the reentrancy answer as much as the
        // guard is, and a claim is the one path here that hands control to an
        // outside contract.
        claimed[roundId][user] = true;

        ISettlementSink sink = settlementSinkOf[roundId][user];
        address recipient = address(sink) == address(0) ? user : address(sink);

        stakeAsset.safeTransfer(recipient, amount);
        if (address(sink) != address(0)) sink.onPositionSettled(user, amount);

        emit Claimed(roundId, user, amount, recipient);
        return amount;
    }

    // ------------------------------------------------------------------
    // Administration
    // ------------------------------------------------------------------

    /// @notice Allow (or stop allowing) a contract to open positions on
    /// behalf of users. Revocation leaves existing positions alone: their
    /// sink is already recorded per round, and rerouting funds that are
    /// mid-round would be the actual danger.
    function setRouter(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        isRouter[router] = allowed;
        emit RouterSet(router, allowed);
    }

    /// @notice Withdraw collected rake.
    /// @dev Bounded by `protocolFees` rather than by the token balance, so
    /// the owner can never reach into stakes that are still owed to users —
    /// including the stakes of a round that is open, locked, or resolved but
    /// unclaimed.
    function withdrawFees(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > protocolFees) revert InsufficientFees(amount, protocolFees);

        protocolFees -= amount;
        stakeAsset.safeTransfer(to, amount);

        emit FeesWithdrawn(to, amount);
    }
}
