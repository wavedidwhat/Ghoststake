package keeper

import (
	"context"
	"fmt"
	"log/slog"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"

	"forge.wavedidwhat.com/wave/ghoststake/internal/abis"
	"forge.wavedidwhat.com/wave/ghoststake/internal/chain"
)

// Market is one ParimutuelRound and everything the keeper had to read off the
// chain to drive it.
//
// Built once at startup. Every field on it is a Solidity `immutable` or a
// deployment fact, so there is nothing here that a later block could change —
// except `Owner`, which is re-read before each owner-only action rather than
// trusted from startup.
type Market struct {
	Address common.Address

	round  *chain.Contract
	oracle *chain.Contract
	feed   *chain.Contract

	Timing Timing

	// Session is the trading calendar this market's feed is expected to
	// follow, or nil for a feed with no schedule. Consulted only for the
	// forward-looking half of the open gate — see forwardCheck.
	Session *Session

	// calendarDisqualified is set once this feed has been observed
	// publishing well outside the session above. From then on the calendar is
	// not applied to this market: a feed that publishes at three in the
	// morning is not keeping market hours, whatever a list says.
	//
	// One-way and never reset. Evidence that the calendar is wrong about this
	// feed does not expire, and a flag that flapped would have the market
	// opening rounds on alternate ticks.
	calendarDisqualified bool

	// StrikeAtOpen is whether this deployment takes a strike when a round is
	// opened (GHO-79). False for the markets deployed before it, which are
	// still live and still have to be driven — see SupportsStrikeAtOpen.
	StrikeAtOpen bool

	// Event is whether this market settles a question rather than a price
	// (GHO-80). Such a market has no feed at all, so everything downstream
	// that reads one — the trading session, the liveness measurement, the
	// binary search for a settlement round — is skipped rather than given a
	// stand-in. See LoadMarket.
	Event bool

	// Question is the event oracle's own `question()`, in the words it will
	// be judged by. Empty for a price market.
	//
	// Read from the oracle rather than configured, for the reason
	// MarketRegistry gives for storing no labels: a copy can disagree with
	// the thing it describes, and the copy is the one you would read.
	Question string

	// Liveness is the feed's measured publication cadence, read once at
	// startup. Only Heartbeat and Known are meaningful here — LastPublished
	// is filled in per check, because it is the part that goes stale.
	Liveness Liveness

	// status is the venue's own market-status feed, if one was configured.
	// Authoritative when present: a venue publishing its own state beats
	// anything inferred from a calendar or a cadence.
	status *chain.Contract

	// Horizon is the round length the registry says this market is meant to
	// run at. Advisory — nothing on chain enforces it — and zero for a market
	// configured by address rather than listed.
	Horizon uint64

	// Description is the feed's own `description()`, e.g. "ETH / USD". Used
	// only in logs, and read from the feed rather than configured, for the
	// reason MarketRegistry gives for storing no labels: a copy can disagree
	// with the thing it describes, and the copy is the one you would read.
	Description string
}

// SessionLabel names this market's gating in a log line, because "why did
// this market not open a round all weekend" should be answerable from the
// line that announced it.
func (m *Market) SessionLabel() string {
	if m.Event {
		// Not "24/7", which would suggest a market that opens rounds around
		// the clock. This one opens none at all.
		return "no schedule (a question)"
	}
	if m.Session == nil {
		return "24/7"
	}
	return "US market hours"
}

// HeartbeatLabel reports the feed's measured cadence, which is what decides
// whether a market opens rounds at all. "not measured" explains a market that
// never gates, and a heartbeat wildly unlike the feed's documented one
// explains a market that gates too often.
func (m *Market) HeartbeatLabel() string {
	if m.Event {
		return "no feed (a question)"
	}
	if !m.Liveness.Known {
		return "not measured (too few rounds)"
	}
	return m.Liveness.Heartbeat.String()
}

func (m *Market) String() string {
	if m.Description == "" {
		return m.Address.Hex()
	}
	return fmt.Sprintf("%s (%s)", m.Address.Hex(), m.Description)
}

// LoadMarket reads a market's immutables and resolves its feed.
//
// Everything is read at startup and cached, deliberately: these are
// `immutable` in Solidity, so a per-tick re-read would be the same request
// returning the same answer forever. A redeploy is a new address and a
// restart.
func LoadMarket(ctx context.Context, client *chain.Client, address string, horizon uint64, nyse *Session, statusFeed string) (*Market, error) {
	round, err := client.Bind(abis.ParimutuelRound, address)
	if err != nil {
		return nil, err
	}

	timing, err := readTiming(ctx, round)
	if err != nil {
		return nil, err
	}

	m := &Market{
		Address: round.Address(),
		round:   round,
		Timing:  timing,
		Horizon: horizon,
	}

	oracleAddr, err := callAddress(ctx, round, "oracle")
	if err != nil {
		return nil, err
	}

	// Which shape of oracle this is, asked of its bytecode. Before GHO-91
	// this was assumed: every oracle was a price adapter, so an event
	// market's oracle was bound to the Chainlink ABI, `feed()` reverted, and
	// the error came back out of LoadMarket and took the keeper's *entire*
	// market list with it — one question would have stopped every price
	// market the keeper drives.
	oracleCode, err := client.CodeAt(ctx, oracleAddr.Hex())
	if err != nil {
		return nil, err
	}
	m.Event = IsEventOracle(oracleCode)

	oracleABI := abis.ChainlinkRoundOracle
	if m.Event {
		oracleABI = abis.EventRoundOracle
	}
	if m.oracle, err = client.Bind(oracleABI, oracleAddr.Hex()); err != nil {
		return nil, err
	}

	// Asked once, for the same reason as everything else here: a contract's
	// code cannot change, so the answer cannot either.
	code, err := client.CodeAt(ctx, round.Address().Hex())
	if err != nil {
		return nil, err
	}
	m.StrikeAtOpen = SupportsStrikeAtOpen(code)

	if m.Event {
		// A question has no feed, no trading session and no cadence. It is
		// opened once, by whoever deploys it, and the keeper's job is the
		// other half: lock it when entry closes and settle it when the
		// outcome goes final. Both work unchanged — GHO-79 removed the only
		// feed read the lock had.
		if m.Question, err = readQuestion(ctx, m.oracle); err != nil {
			return nil, fmt.Errorf("keeper: %s's oracle at %s answers question() with nothing readable: %w",
				round.Address().Hex(), oracleAddr.Hex(), err)
		}
		m.Description = m.Question
		m.Session = AlwaysOpen()
		return m, nil
	}

	feedAddr, err := callAddress(ctx, m.oracle, "feed")
	if err != nil {
		return nil, err
	}
	if m.feed, err = client.Bind(abis.AggregatorV3Interface, feedAddr.Hex()); err != nil {
		return nil, err
	}

	// Asserted before anything reads the feed for real. `Bind` only checks
	// that the address is hex, and every read off an address with no code
	// comes back empty — which `followsTradingSession` below would take as
	// "not a Stock Token feed" and `ReadFeedRound` would take as "this round
	// holds no data". Both are plausible answers, both are wrong, and the
	// market would load cleanly and then never lock a round. `decimals()` is
	// the cheapest question every aggregator answers.
	if _, err := m.feed.CallUint64(ctx, nil, "decimals"); err != nil {
		return nil, fmt.Errorf("keeper: %s's feed at %s does not answer as a price feed: %w",
			round.Address().Hex(), feedAddr.Hex(), err)
	}

	m.Description = readDescription(ctx, m.feed)

	gated, err := followsTradingSession(ctx, client, feedAddr)
	if err != nil {
		return nil, err
	}
	if gated {
		m.Session = nyse
	} else {
		m.Session = AlwaysOpen()
	}

	// Measured once. The cadence is a property of the feed and does not move;
	// how long ago it last published is read per check, where it matters.
	latestID, err := m.LatestFeedRoundID(ctx)
	if err != nil {
		return nil, err
	}
	if m.Liveness, err = Observe(ctx, m.ReadFeedRound, latestID); err != nil {
		return nil, err
	}

	if statusFeed != "" {
		if m.status, err = client.Bind(abis.AggregatorV3Interface, statusFeed); err != nil {
			return nil, err
		}
		// Read once at startup rather than trusted at first use. A status
		// feed pointed at the wrong address answers nothing, and the gate
		// would then either refuse every round or error on every tick — both
		// discovered hours later, in production, at the moment it mattered.
		if _, err := m.VenueOpen(ctx); err != nil {
			return nil, fmt.Errorf("keeper: %s's market status feed at %s does not answer: %w",
				m.Address.Hex(), statusFeed, err)
		}
	}
	return m, nil
}

// VenueOpen reads the configured market-status feed.
//
// The convention these feeds use is an ordinary AggregatorV3Interface whose
// answer is a flag rather than a price: non-zero is open. Read through the
// same interface as any other feed, because that is what it is.
func (m *Market) VenueOpen(ctx context.Context) (bool, error) {
	values, err := m.status.CallAt(ctx, nil, "latestRoundData")
	if err != nil {
		return false, err
	}
	answer, ok := values[1].(*big.Int)
	if !ok {
		return false, fmt.Errorf("keeper: market status feed returned %T for answer, want *big.Int", values[1])
	}
	return answer.Sign() != 0, nil
}

// followsTradingSession decides whether this feed's market has opening hours.
//
// Asked of the chain rather than configured. Robinhood Chain's Stock Token
// feeds implement `oraclePaused()` — the advisory corporate-action flag — and
// crypto feeds do not; `ChainlinkRoundOracle` already relies on exactly that
// distinction, wrapping the call in a try/catch and reading a revert as
// "unpaused, because this is not a Stock Token feed".
//
// So the presence of the function *is* the market-hours signal, and taking it
// from the chain rather than from an environment variable follows the rule
// MarketRegistry sets out: a configured copy of a derivable fact can disagree
// with the contract, and forgetting to set it here means opening stock rounds
// into a closed market all weekend.
//
// A transport failure is returned as an error rather than assumed either way.
// Guessing "crypto" would ungate a stock market; guessing "stock" would stop
// a crypto market opening rounds at all. Refusing to start is the only answer
// that is not silently wrong.
func followsTradingSession(ctx context.Context, client *chain.Client, feed common.Address) (bool, error) {
	pausable, err := client.Bind(abis.IPausableOracle, feed.Hex())
	if err != nil {
		return false, err
	}
	if _, err := pausable.CallAt(ctx, nil, "oraclePaused"); err != nil {
		if chain.IsRevert(err) || strings.Contains(err.Error(), "returned no data") {
			return false, nil
		}
		return false, fmt.Errorf("keeper: probing %s for oraclePaused(): %w", feed.Hex(), err)
	}
	return true, nil
}

// RoundCount is the highest round id the market has opened.
func (m *Market) RoundCount(ctx context.Context) (uint64, error) {
	n, err := m.round.CallBig(ctx, nil, "roundCount")
	if err != nil {
		return 0, err
	}
	return n.Uint64(), nil
}

// RoundAt reads one round's stored state.
func (m *Market) RoundAt(ctx context.Context, id uint64) (Round, error) {
	var r Round
	err := m.round.CallInto(ctx, nil, &r, "rounds", new(big.Int).SetUint64(id))
	return r, err
}

// Owner is the address `openRound` and `voidUnsettledRound` will accept.
//
// Re-read rather than cached: ownership is transferable, and a keeper that
// cached "not the owner" at startup would keep declining to open rounds after
// somebody handed it the market.
func (m *Market) Owner(ctx context.Context) (common.Address, error) {
	return callAddress(ctx, m.round, "owner")
}

// LatestFeedRoundID is the feed's current round id, the ceiling for a search.
func (m *Market) LatestFeedRoundID(ctx context.Context) (*big.Int, error) {
	id, _, err := m.LatestFeedRound(ctx)
	return id, err
}

// LatestFeedRound is the feed's newest round: its id, for bounding a search,
// and when it landed, for deciding whether the feed is still alive.
//
// Both come from one `latestRoundData` call because they always want to be
// consistent with each other — an id from one block paired with a timestamp
// from another describes a round that never existed.
func (m *Market) LatestFeedRound(ctx context.Context) (*big.Int, *FeedRound, error) {
	values, err := m.feed.CallAt(ctx, nil, "latestRoundData")
	if err != nil {
		if chain.IsRevert(err) {
			// A feed that has never published. Real on the demo feed before
			// anyone pushes a price, and not an error.
			return nil, nil, nil
		}
		return nil, nil, err
	}
	id, ok := values[0].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("keeper: latestRoundData returned %T for roundId, want *big.Int", values[0])
	}
	updatedAt, ok := values[3].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("keeper: latestRoundData returned %T for updatedAt, want *big.Int", values[3])
	}
	if updatedAt.Sign() == 0 {
		return id, nil, nil
	}
	return id, &FeedRound{UpdatedAt: updatedAt.Uint64()}, nil
}

// ReadFeedRound is the RoundReader FindCloseRound searches with.
func (m *Market) ReadFeedRound(ctx context.Context, id *big.Int) (*FeedRound, error) {
	values, err := m.feed.CallAt(ctx, nil, "getRoundData", id)
	if err != nil {
		if chain.IsRevert(err) || strings.Contains(err.Error(), "returned no data") {
			return nil, nil
		}
		return nil, err
	}
	// (roundId, answer, startedAt, updatedAt, answeredInRound)
	updatedAt, ok := values[3].(*big.Int)
	if !ok {
		return nil, fmt.Errorf("keeper: getRoundData returned %T for updatedAt, want *big.Int", values[3])
	}
	if updatedAt.Sign() == 0 {
		// A published round always carries a timestamp. Zero means an
		// aggregator that answers for unknown ids rather than reverting, and
		// it means the same thing: no data.
		return nil, nil
	}
	return &FeedRound{UpdatedAt: updatedAt.Uint64()}, nil
}

// SettlementReadable dry-runs the adapter's own check on a candidate feed
// round, and is the only thing that predicts whether `resolveRound` lands.
//
// The search knows timestamps. The adapter knows about staleness bounds, L2
// sequencer uptime, the post-recovery grace period and the advisory pause
// flag on Stock Token feeds — none of which a timestamp comparison can see.
// Asking it costs one eth_call and turns a reverted transaction into a log
// line saying to wait.
func (m *Market) SettlementReadable(ctx context.Context, feedRoundID *big.Int, closeTime uint64) (bool, error) {
	values, err := m.oracle.CallAt(ctx, nil, "readAt", feedRoundID, new(big.Int).SetUint64(closeTime))
	if err != nil {
		return false, err
	}
	ok, isBool := values[0].(bool)
	if !isBool {
		return false, fmt.Errorf("keeper: readAt returned %T for ok, want bool", values[0])
	}
	return ok, nil
}

func readTiming(ctx context.Context, round *chain.Contract) (Timing, error) {
	// The three windows are `uint64` on the contract and the floor is
	// `uint256`, which is why they do not share a helper.
	entryCutoff, err := round.CallUint64(ctx, nil, "entryCutoff")
	if err != nil {
		return Timing{}, err
	}
	lockWindow, err := round.CallUint64(ctx, nil, "lockWindow")
	if err != nil {
		return Timing{}, err
	}
	resolveDeadline, err := round.CallUint64(ctx, nil, "resolveDeadline")
	if err != nil {
		return Timing{}, err
	}
	minSidePool, err := round.CallBig(ctx, nil, "minSidePool")
	if err != nil {
		return Timing{}, err
	}
	return Timing{
		EntryCutoff:     entryCutoff,
		LockWindow:      lockWindow,
		ResolveDeadline: resolveDeadline,
		MinSidePool:     minSidePool,
	}, nil
}

func callAddress(ctx context.Context, c *chain.Contract, method string) (common.Address, error) {
	values, err := c.CallAt(ctx, nil, method)
	if err != nil {
		return common.Address{}, err
	}
	addr, ok := values[0].(common.Address)
	if !ok {
		return common.Address{}, fmt.Errorf("keeper: %s returned %T, want address", method, values[0])
	}
	if addr == (common.Address{}) {
		return common.Address{}, fmt.Errorf("keeper: %s is the zero address", method)
	}
	return addr, nil
}

// readDescription is best-effort: it names the market in logs and nothing
// depends on it, so a feed that does not implement it is not a reason to
// refuse to drive it.
func readDescription(ctx context.Context, feed *chain.Contract) string {
	values, err := feed.CallAt(ctx, nil, "description")
	if err != nil {
		slog.Debug("feed has no description()", "feed", feed.Address().Hex(), "err", err)
		return ""
	}
	text, ok := values[0].(string)
	if !ok {
		return ""
	}
	return text
}

// readQuestion is the event oracle's own `question()`.
//
// An error rather than an empty string, unlike readDescription: a feed with
// no description is cosmetic, but a question that cannot be read is an oracle
// that is not the shape the bytecode probe said it was, and loading the
// market anyway would mean driving a market nobody can see the question of.
func readQuestion(ctx context.Context, oracle *chain.Contract) (string, error) {
	values, err := oracle.CallAt(ctx, nil, "question")
	if err != nil {
		return "", err
	}
	text, ok := values[0].(string)
	if !ok {
		return "", fmt.Errorf("question() returned %T, want string", values[0])
	}
	if text == "" {
		// The constructor refuses one, so an empty question means this is not
		// an EventRoundOracle at all.
		return "", fmt.Errorf("question() is empty")
	}
	return text, nil
}

// Spot is the price the market's own oracle would report right now, in the
// adapter's 18-decimal scale — the same scale a strike is stored in.
//
// Read through the adapter rather than the feed directly, so the keeper
// strikes against a price the *contract* would accept: the adapter applies
// its own staleness bound and, on an L2, its sequencer-uptime check. A strike
// chosen from a raw feed read the adapter would refuse is a round opened on a
// number the settlement path does not believe in.
//
// `ok` false means the adapter has no usable price at the moment. Not an
// error: it is the ordinary state of a feed between publications on a quiet
// chain, and the caller's job is to not open a round yet.
func (m *Market) Spot(ctx context.Context) (price *big.Int, ok bool, err error) {
	values, err := m.oracle.CallAt(ctx, nil, "readLatest")
	if err != nil {
		return nil, false, err
	}
	usable, isBool := values[0].(bool)
	if !isBool {
		return nil, false, fmt.Errorf("keeper: readLatest returned %T for ok, want bool", values[0])
	}
	if !usable {
		return nil, false, nil
	}
	price, isInt := values[1].(*big.Int)
	if !isInt {
		return nil, false, fmt.Errorf("keeper: readLatest returned %T for price, want *big.Int", values[1])
	}
	return price, true, nil
}
