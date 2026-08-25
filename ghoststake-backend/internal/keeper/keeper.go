package keeper

import (
	"context"
	"fmt"
	"log/slog"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/wavedidwhat/ghoststake/internal/chain"
)

// Config is what an operator chooses; everything else the keeper reads off
// the chain.
type Config struct {
	// PollInterval is how often every market is examined. It bounds how late
	// a lock can be, so it has to be comfortably shorter than the market's
	// lockWindow — checked at startup rather than discovered by a voided
	// round.
	PollInterval time.Duration

	// OpenRounds is whether to open new rounds at all. Off leaves a keeper
	// that only advances rounds somebody else opened, which is the useful
	// shape when the owner key lives elsewhere.
	OpenRounds bool

	// Lead is how far ahead of now a new round's openTime is set. `openRound`
	// rejects a start in the past, and the gap between simulating and mining
	// eats a short lead.
	Lead uint64

	// EntryWindow is openTime to lockTime, in seconds. Zero means half the
	// market's horizon.
	EntryWindow uint64

	// Horizon is openTime to closeTime for a market the registry gives no
	// horizon for.
	Horizon uint64

	// MinGasBalance is the balance below which the keeper starts warning on
	// every tick. It never stops working over this — a keeper that refused to
	// try is indistinguishable from one that is out of gas, and the one that
	// tries at least lands the transactions it can still afford.
	MinGasBalance *big.Int
}

// Keeper drives every market it was given.
type Keeper struct {
	client  *chain.Client
	signer  *chain.Signer
	markets []*Market
	cfg     Config

	// cursor is the lowest round id per market that might still need an
	// action. Rounds below it are Resolved or Void, which are terminal, so
	// re-reading them every tick is a request per settled round forever.
	cursor map[common.Address]uint64

	// retry holds a per-(market, round, action) backoff. Keyed by a string
	// because the tuple is only ever compared for equality.
	retry map[string]*attempt

	// notOwner remembers which markets we have already said we cannot open
	// rounds on, so that stays one log line rather than one per tick.
	notOwner map[common.Address]bool

	// maxBackoff is derived from the tightest deadline any of these markets
	// imposes; see New.
	maxBackoff time.Duration
}

type attempt struct {
	next     time.Time
	failures int
}

// backoffCeiling caps the retry delay however many times an action has
// failed. Never longer than this, and usually shorter — see maxBackoff.
const backoffCeiling = 30 * time.Second

func New(client *chain.Client, signer *chain.Signer, markets []*Market, cfg Config) (*Keeper, error) {
	if len(markets) == 0 {
		return nil, fmt.Errorf("keeper: no markets to drive")
	}
	if cfg.PollInterval <= 0 {
		return nil, fmt.Errorf("keeper: poll interval must be positive")
	}

	for _, m := range markets {
		// A poll slower than the lock window means every round is locked late
		// or not at all, and the symptom is rounds voiding for
		// "lock window missed" with nothing in the logs looking wrong.
		if window := time.Duration(m.Timing.LockWindow) * time.Second; cfg.PollInterval >= window {
			return nil, fmt.Errorf(
				"keeper: poll interval %s is not shorter than %s's lock window of %s — every round would void",
				cfg.PollInterval, m.Address.Hex(), window)
		}
		if cfg.OpenRounds {
			if _, _, err := m.schedulePlan(cfg); err != nil {
				return nil, err
			}
		}
	}

	return &Keeper{
		client:     client,
		signer:     signer,
		markets:    markets,
		cfg:        cfg,
		cursor:     map[common.Address]uint64{},
		retry:      map[string]*attempt{},
		notOwner:   map[common.Address]bool{},
		maxBackoff: backoffLimit(markets),
	}, nil
}

// backoffLimit is the longest a retry may wait: a third of the tightest lock
// window across these markets, capped and floored.
//
// The lock window is the only deadline the keeper can actually miss by
// waiting — past it a round voids, whatever is staked. A fixed one-minute
// ceiling against a sixty-second window meant that four consecutive failures
// consumed the entire window, and the round the keeper was retrying voided
// while it was still backing off. A third leaves room for three attempts
// inside it.
func backoffLimit(markets []*Market) time.Duration {
	limit := backoffCeiling
	for _, m := range markets {
		if third := time.Duration(m.Timing.LockWindow) * time.Second / 3; third < limit {
			limit = third
		}
	}
	if limit < time.Second {
		limit = time.Second
	}
	return limit
}

// Run polls until the context is cancelled.
//
// Never returns an error for a failed action. A keeper that exited on the
// first RPC hiccup would be a keeper that is down more often than the chain
// is — every failure here is retried with backoff and the loop keeps going.
// Only a cancelled context stops it.
func (k *Keeper) Run(ctx context.Context) error {
	ticker := time.NewTicker(k.cfg.PollInterval)
	defer ticker.Stop()

	k.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			slog.Info("keeper stopping")
			return nil
		case <-ticker.C:
			k.tick(ctx)
		}
	}
}

func (k *Keeper) tick(ctx context.Context) {
	now, err := k.chainTime(ctx)
	if err != nil {
		slog.Warn("keeper: could not read chain time", "err", err)
		return
	}
	k.checkGas(ctx)

	for _, m := range k.markets {
		if err := k.driveMarket(ctx, m, now); err != nil {
			slog.Warn("keeper: market tick failed", "market", m.String(), "err", err)
		}
	}
}

// chainTime is the timestamp the keeper's next transaction will execute
// against.
//
// Not the wall clock, and not the head block either. Every deadline the
// keeper reasons about is compared against `block.timestamp` inside the
// contract, and both of the obvious clocks are wrong in a way that shows up
// as a transaction that cannot succeed:
//
//   - The wall clock is wrong on any chain running an offset. `anvil` warps
//     time on request and the local stack warps it by 130 seconds while
//     seeding, so every block after that is two minutes ahead of the laptop
//     that mined it.
//   - The head block is wrong on a chain that mines on demand. An idle anvil
//     leaves its newest block minutes in the past, so a round opened with a
//     45-second lead lands with its `openTime` already behind the block that
//     executes it, and `openRound` reverts with InvalidSchedule. That is the
//     failure this function was written for; it cost an afternoon.
//
// The pending block is neither. It is the node's own answer to "what
// timestamp would I stamp on a block right now", which is exactly the number
// the guards will be compared against.
//
// Not every RPC serves a pending block, so the fallback is the later of the
// head and the wall clock. Being slightly ahead is the safe direction: a lock
// sent a second early is refused by the simulation and retried, where one
// sent a minute late voids the round.
func (k *Keeper) chainTime(ctx context.Context) (uint64, error) {
	if pending, err := k.client.HeaderByNumber(ctx, chain.PendingBlockNumber); err == nil && pending != nil && pending.Time > 0 {
		return pending.Time, nil
	}
	head, err := k.client.HeaderByNumber(ctx, nil)
	if err != nil {
		return 0, err
	}
	if wall := uint64(time.Now().Unix()); wall > head.Time {
		return wall, nil
	}
	return head.Time, nil
}

func (k *Keeper) checkGas(ctx context.Context) {
	if k.cfg.MinGasBalance == nil || k.cfg.MinGasBalance.Sign() == 0 {
		return
	}
	balance, err := k.signer.Balance(ctx)
	if err != nil {
		slog.Warn("keeper: could not read gas balance", "err", err)
		return
	}
	if balance.Cmp(k.cfg.MinGasBalance) < 0 {
		slog.Warn("keeper: gas balance is low",
			"address", k.signer.Address().Hex(),
			"balance_wei", balance.String(),
			"threshold_wei", k.cfg.MinGasBalance.String())
	}
}

func (k *Keeper) driveMarket(ctx context.Context, m *Market, now uint64) error {
	count, err := m.RoundCount(ctx)
	if err != nil {
		return err
	}

	from := k.cursor[m.Address]
	if from == 0 {
		from = 1
	}

	var latest Round
	advance := true
	for id := from; id <= count; id++ {
		round, err := m.RoundAt(ctx, id)
		if err != nil {
			return fmt.Errorf("read round %d: %w", id, err)
		}
		if id == count {
			latest = round
		}

		state := round.State()
		if state == StatusResolved || state == StatusVoid {
			// Terminal. The cursor only moves past a prefix of settled
			// rounds: round 4 settling before round 3 is normal (3 may be
			// waiting on a feed), and moving the cursor to 5 would abandon it.
			if advance {
				k.cursor[m.Address] = id + 1
				// A round that failed on its way to settling leaves backoff
				// state behind. Terminal is terminal, so drop it rather than
				// carrying a map entry per round the market ever ran.
				k.forget(m, id)
			}
			continue
		}
		advance = false

		if err := k.driveRound(ctx, m, id, round, now); err != nil {
			slog.Warn("keeper: round action failed",
				"market", m.String(), "round", id, "err", err)
		}
	}

	if !k.cfg.OpenRounds {
		return nil
	}
	if !NeedsNewRound(latest, m.Timing.EntryCutoff, now) {
		return nil
	}
	return k.openRound(ctx, m, now)
}

func (k *Keeper) driveRound(ctx context.Context, m *Market, id uint64, round Round, now uint64) error {
	action := ActionFor(round, m.Timing, now)
	if action == ActionNone {
		return nil
	}
	if !k.ready(m, id, action) {
		return nil
	}

	switch action {
	case ActionLock:
		if Thin(round, m.Timing.MinSidePool) {
			slog.Info("keeper: locking a thin round, which will void and refund it",
				"market", m.String(), "round", id,
				"up", round.UpPool, "down", round.DownPool, "floor", m.Timing.MinSidePool)
		}
		return k.send(ctx, m, id, action, "lockRound", new(big.Int).SetUint64(id))

	case ActionVoidUnlocked:
		return k.send(ctx, m, id, action, "voidUnlockedRound", new(big.Int).SetUint64(id))

	case ActionResolve, ActionVoidUnsettled:
		return k.settle(ctx, m, id, round, action)
	}
	return nil
}

// actionOpen is not one of ActionFor's answers — opening is a property of the
// market rather than of any round, since the round it creates has no id until
// it exists. It shares the backoff and logging machinery all the same.
const actionOpen Action = "open"

// settle resolves a locked round, or refunds it when there is nothing to
// settle against and the deadline has passed.
//
// The resolve is attempted first even past the deadline, deliberately. The
// deadline is a permission to refund, not an instruction to: a feed that
// publishes an hour late still settles the round correctly, and everyone in
// it would rather be paid than refunded. Voiding is only reached when the
// search finds no candidate, or the adapter refuses the one it found.
func (k *Keeper) settle(ctx context.Context, m *Market, id uint64, round Round, action Action) error {
	feedRoundID, err := k.findSettlementRound(ctx, m, round)
	if err != nil {
		return err
	}

	if feedRoundID != nil {
		return k.send(ctx, m, id, ActionResolve, "resolveRound",
			new(big.Int).SetUint64(id), feedRoundID)
	}

	if action != ActionVoidUnsettled {
		// Inside the deadline with nothing to settle against yet. This is the
		// pinning rule working, not a failure: wait for the feed.
		slog.Debug("keeper: no usable feed round at close yet, waiting",
			"market", m.String(), "round", id, "close_time", round.CloseTime)
		return nil
	}

	owner, err := m.Owner(ctx)
	if err != nil {
		return err
	}
	if owner != k.signer.Address() {
		slog.Warn("keeper: round is past its resolve deadline with no usable feed round, and only the owner can refund it",
			"market", m.String(), "round", id, "owner", owner.Hex())
		return nil
	}
	slog.Info("keeper: refunding a round nobody could settle",
		"market", m.String(), "round", id)
	return k.send(ctx, m, id, ActionVoidUnsettled, "voidUnsettledRound", new(big.Int).SetUint64(id))
}

// findSettlementRound returns the feed round `resolveRound` should name, or
// nil when there is not one the adapter will accept.
func (k *Keeper) findSettlementRound(ctx context.Context, m *Market, round Round) (*big.Int, error) {
	latestFeedID, err := m.LatestFeedRoundID(ctx)
	if err != nil {
		return nil, fmt.Errorf("read latest feed round: %w", err)
	}
	if latestFeedID == nil {
		return nil, nil
	}

	candidate, err := FindCloseRound(ctx, m.ReadFeedRound, latestFeedID, round.CloseTime)
	if err != nil {
		return nil, err
	}
	if candidate == nil {
		return nil, nil
	}

	// The search compared timestamps. The adapter is the one that knows about
	// staleness, sequencer uptime and the pause flag, and only its answer
	// predicts whether the transaction lands.
	readable, err := m.SettlementReadable(ctx, candidate, round.CloseTime)
	if err != nil {
		return nil, fmt.Errorf("dry-run readAt: %w", err)
	}
	if !readable {
		slog.Info("keeper: the adapter refuses the feed round at this close — stale, sequencer, or paused",
			"market", m.String(), "feed_round", candidate.String(), "close_time", round.CloseTime)
		return nil, nil
	}
	return candidate, nil
}

func (k *Keeper) openRound(ctx context.Context, m *Market, now uint64) error {
	owner, err := m.Owner(ctx)
	if err != nil {
		return err
	}
	if owner != k.signer.Address() {
		if !k.notOwner[m.Address] {
			k.notOwner[m.Address] = true
			slog.Warn("keeper: not this market's owner, so it will advance rounds but never open them",
				"market", m.String(), "owner", owner.Hex(), "keeper", k.signer.Address().Hex())
		}
		return nil
	}
	k.notOwner[m.Address] = false

	entryWindow, observation, err := m.schedulePlan(k.cfg)
	if err != nil {
		return err
	}
	schedule := NextSchedule(now, k.cfg.Lead, entryWindow, observation)
	if problem := ScheduleProblem(schedule, m.Timing.EntryCutoff, now); problem != "" {
		return fmt.Errorf("refusing to open a round: %s", problem)
	}

	// The session gate. Both ends matter: opening inside a session that closes
	// before `closeTime` is the straddles-the-bell case, where the feed stops
	// publishing partway through the round and there is nothing to settle it
	// against.
	openAt := time.Unix(int64(schedule.OpenTime), 0)
	closeAt := time.Unix(int64(schedule.CloseTime), 0)
	if !m.Session.OpenThroughout(openAt, closeAt) {
		slog.Debug("keeper: market session is closed for this window, not opening a round",
			"market", m.String(), "open", openAt.UTC(), "close", closeAt.UTC())
		return nil
	}

	// Keyed on round 0, which is not a round: "the next one" has no id yet,
	// and this is the one action whose backoff is per market rather than per
	// round.
	if !k.ready(m, 0, actionOpen) {
		return nil
	}
	return k.send(ctx, m, 0, actionOpen, "openRound",
		schedule.OpenTime, schedule.LockTime, schedule.CloseTime)
}

// schedulePlan is SplitHorizon for this market, falling back to the config's
// horizon when the registry gave the market none.
func (m *Market) schedulePlan(cfg Config) (entryWindow, observation uint64, err error) {
	horizon := m.Horizon
	if horizon == 0 {
		horizon = cfg.Horizon
	}
	if horizon == 0 {
		return 0, 0, fmt.Errorf("keeper: %s has no horizon and KEEPER_HORIZON is unset", m.Address.Hex())
	}
	entryWindow, observation, err = SplitHorizon(horizon, cfg.EntryWindow, m.Timing.EntryCutoff)
	if err != nil {
		return 0, 0, fmt.Errorf("keeper: %s: %w", m.Address.Hex(), err)
	}
	return entryWindow, observation, nil
}

// SplitHorizon divides a market's horizon into an entry window and an
// observation window.
//
// The horizon is what the registry says the market is meant to be run at, and
// it is read here as the whole round: open to close. That is the reading that
// makes "a 5-minute market" produce a round every five minutes, which is what
// an operator listing one at that horizon is asking for. The registry calls
// it "the round length" and stores it as advisory, so nothing on chain
// disagrees either way — but the reading is a choice, and this is where it is
// made.
//
// Half to taking positions and half to watching the price, unless an operator
// names an entry window explicitly.
//
// Validated rather than clamped. A round whose entry window does not outlast
// the entry cutoff opens with entry already closed, and quietly stretching an
// operator's number to make it fit would produce a market running at a
// cadence nobody asked for.
func SplitHorizon(horizon, entryWindow, entryCutoff uint64) (uint64, uint64, error) {
	if entryWindow == 0 {
		entryWindow = horizon / 2
	}
	if entryWindow <= entryCutoff {
		return 0, 0, fmt.Errorf(
			"an entry window of %ds is not longer than the %ds entry cutoff, so rounds would open with entry already closed",
			entryWindow, entryCutoff)
	}
	if entryWindow >= horizon {
		return 0, 0, fmt.Errorf(
			"an entry window of %ds inside a %ds horizon leaves no observation window",
			entryWindow, horizon)
	}
	return entryWindow, horizon - entryWindow, nil
}

// send simulates, submits and waits, then clears or extends the backoff.
func (k *Keeper) send(ctx context.Context, m *Market, id uint64, action Action, method string, args ...any) error {
	hash, err := k.signer.Send(ctx, m.round, method, args...)
	if err != nil {
		k.failed(m, id, action)
		if hash != (common.Hash{}) {
			return fmt.Errorf("%s: %w (tx %s)", method, err, hash.Hex())
		}
		return fmt.Errorf("%s: %w", method, err)
	}
	k.succeeded(m, id, action)
	slog.Info("keeper: sent", "market", m.String(), "round", id, "action", action, "tx", hash.Hex())
	return nil
}

// ready reports whether this action is off backoff.
func (k *Keeper) ready(m *Market, id uint64, action Action) bool {
	a, ok := k.retry[retryKey(m, id, action)]
	return !ok || !time.Now().Before(a.next)
}

// failed extends the backoff for one action, doubling from the poll interval
// and capped by backoffLimit.
//
// Bounded low on purpose. The failures worth backing off from here are an RPC
// refusing requests and a guard that has not opened yet, and both clear on
// their own — a backoff measured in minutes keeps the keeper idle well past
// the lock window the failure was about, which is how a retry turns into a
// voided round.
func (k *Keeper) failed(m *Market, id uint64, action Action) {
	key := retryKey(m, id, action)
	a, ok := k.retry[key]
	if !ok {
		a = &attempt{}
		k.retry[key] = a
	}
	a.failures++

	delay := k.cfg.PollInterval << min(a.failures-1, 8)
	if delay > k.maxBackoff {
		delay = k.maxBackoff
	}
	a.next = time.Now().Add(delay)
	slog.Debug("keeper: backing off", "market", m.String(), "round", id,
		"action", action, "failures", a.failures, "retry_in", delay)
}

func (k *Keeper) succeeded(m *Market, id uint64, action Action) {
	delete(k.retry, retryKey(m, id, action))
}

// forget drops every backoff entry for one round.
func (k *Keeper) forget(m *Market, id uint64) {
	for _, action := range []Action{ActionLock, ActionResolve, ActionVoidUnlocked, ActionVoidUnsettled} {
		delete(k.retry, retryKey(m, id, action))
	}
}

func retryKey(m *Market, id uint64, action Action) string {
	return fmt.Sprintf("%s|%d|%s", m.Address.Hex(), id, action)
}
