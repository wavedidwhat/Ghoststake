package httpx

import (
	"context"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/go-chi/chi/v5"

	"forge.wavedidwhat.com/wave/ghoststake/internal/auth"
	"forge.wavedidwhat.com/wave/ghoststake/internal/finance"
	"forge.wavedidwhat.com/wave/ghoststake/internal/ledger"
	"forge.wavedidwhat.com/wave/ghoststake/internal/protocol"
)

// How many rounds a listing returns by default and at most.
//
// Bounded because `?limit=` is user input and the query behind it reads every
// event of every round it returns. An unbounded limit is a request that reads
// the whole table, which is a denial of service anyone can send.
const (
	defaultRoundLimit = 20
	maxRoundLimit     = 100
)

// Every uint256 crosses the wire as a decimal string.
//
// JSON numbers are IEEE-754 doubles, and a token balance in wei exceeds their
// 53 bits of integer precision routinely. `JSON.parse` on a raw number would
// silently fabricate the low digits of a balance — the frontend audit found
// exactly this bug, in the other direction. Strings go into `BigInt()` intact.
type roundJSON struct {
	// Market is the ParimutuelRound this round belongs to, checksummed.
	//
	// Not decoration: round ids restart at 1 in every market, so `id` alone
	// does not identify a round and a client keying a list on it merges two
	// markets' rounds into one row.
	Market string `json:"market"`
	ID     uint64 `json:"id"`
	Status string `json:"status"`
	// Phase is what an observer sees, which differs from status on the clock
	// alone: an open round is in "cutoff" once entry closes, and a locked one
	// sits in "observation" until someone resolves it.
	Phase     string `json:"phase"`
	EntryOpen bool   `json:"entryOpen"`

	OpenTime  time.Time `json:"openTime"`
	LockTime  time.Time `json:"lockTime"`
	CloseTime time.Time `json:"closeTime"`

	UpPool    string `json:"upPool"`
	DownPool  string `json:"downPool"`
	TotalPool string `json:"totalPool"`
	// Odds are WAD: 2000000000000000000 means a winning unit doubles. Zero
	// for an empty side, which is undefined rather than infinite — a side
	// with nothing in it voids the round at lock.
	UpOdds   string `json:"upOdds"`
	DownOdds string `json:"downOdds"`

	LockPrice  *string `json:"lockPrice"`
	ClosePrice *string `json:"closePrice"`
	Winner     string  `json:"winner,omitempty"`
	RakeTaken  *string `json:"rakeTaken"`
	VoidReason string  `json:"voidReason,omitempty"`

	// Question is the claim on this round's outcome, for a round settled by
	// an external question rather than a price feed (GHO-91). Absent — not
	// an empty object — on a price round, so a client can tell "this is a
	// price round" from "nobody has claimed an outcome yet".
	Question *questionJSON `json:"question,omitempty"`

	LastBlock uint64 `json:"lastBlock"`
}

// questionJSON is everything somebody needs to decide whether to argue with
// a claimed outcome.
//
// All of it, not just the answer. A panel showing only "Yes" would be the
// operator call this mechanism exists to replace: what makes the outcome
// trustworthy is that the evidence was named, the window was open, the
// proposer's own position was on the record, and nobody paid to disagree.
type questionJSON struct {
	Oracle  string `json:"oracle,omitempty"`
	State   string `json:"state"`
	Outcome string `json:"outcome,omitempty"`

	Proposer       string     `json:"proposer,omitempty"`
	ProposedAt     *time.Time `json:"proposedAt,omitempty"`
	EvidenceURI    string     `json:"evidenceUri,omitempty"`
	EvidenceDigest string     `json:"evidenceDigest,omitempty"`
	// ProposerStake is what the proposer had riding on this round when they
	// claimed its outcome. "0" is a real answer and is rendered as one.
	ProposerStake string `json:"proposerStake,omitempty"`

	ChallengeClosesAt *time.Time `json:"challengeClosesAt,omitempty"`

	Challenger   string     `json:"challenger,omitempty"`
	ChallengedAt *time.Time `json:"challengedAt,omitempty"`
	RulingDueAt  *time.Time `json:"rulingDueAt,omitempty"`

	Arbiter   string     `json:"arbiter,omitempty"`
	RuledAt   *time.Time `json:"ruledAt,omitempty"`
	ReasonURI string     `json:"reasonUri,omitempty"`
	PaidTo    string     `json:"paidTo,omitempty"`

	AbandonedAt *time.Time `json:"abandonedAt,omitempty"`
}

// renderQuestion maps the projection, or nil for a price round.
func renderQuestion(q *ledger.QuestionState) *questionJSON {
	if q == nil {
		return nil
	}
	stake := ""
	if q.ProposerStake != nil {
		stake = q.ProposerStake.String()
	}
	return &questionJSON{
		Oracle:            q.Oracle,
		State:             string(q.State),
		Outcome:           q.Outcome,
		Proposer:          q.Proposer,
		ProposedAt:        timeOrNil(q.ProposedAt),
		EvidenceURI:       q.EvidenceURI,
		EvidenceDigest:    q.EvidenceDigest,
		ProposerStake:     stake,
		ChallengeClosesAt: timeOrNil(q.ChallengeClosesAt),
		Challenger:        q.Challenger,
		ChallengedAt:      timeOrNil(q.ChallengedAt),
		RulingDueAt:       timeOrNil(q.RulingDueAt),
		Arbiter:           q.Arbiter,
		RuledAt:           timeOrNil(q.RuledAt),
		ReasonURI:         q.ReasonURI,
		PaidTo:            q.PaidTo,
		AbandonedAt:       timeOrNil(q.AbandonedAt),
	}
}

// timeOrNil omits a zero time rather than serialising year 1.
//
// `0001-01-01T00:00:00Z` parses as a valid date in every client, so a zero
// deadline would render as a countdown that expired two thousand years ago
// instead of as "not set".
func timeOrNil(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

type roundsResponse struct {
	ChainID int64 `json:"chainId"`
	// IndexedBlock is how far the indexer has read. A client comparing it
	// with the chain head knows whether "no rounds" means none exist or that
	// the backfill has not reached them yet.
	IndexedBlock uint64      `json:"indexedBlock"`
	AsOf         time.Time   `json:"asOf"`
	Rounds       []roundJSON `json:"rounds"`

	// Degraded names markets that could not be described, so a short listing
	// says so instead of quietly being a short listing. Omitted when empty:
	// an absent field and an empty array would mean the same thing, and only
	// one of them makes the common response smaller.
	Degraded []string `json:"degraded,omitempty"`
}

// handleRounds lists recent rounds with their pool split.
//
// The pools are summed from indexed positions, not read from the contract.
// That is the point of indexing them: a listing of twenty rounds would
// otherwise be forty `eth_call`s, per viewer, per refresh.
func (s *Server) handleRounds(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	limit := clampLimit(r.URL.Query().Get("limit"))

	market, ok := queryMarket(w, r)
	if !ok {
		return
	}

	refs, err := s.store.RecentRounds(ctx, s.cfg.ChainID, market, limit)
	if err != nil {
		serverError(w, "list rounds", err)
		return
	}
	events, err := s.store.RoundEventsByRefs(ctx, s.cfg.ChainID, refs)
	if err != nil {
		serverError(w, "read round events", err)
		return
	}

	now := time.Now().UTC()
	rounds := ledger.Project(events)
	// Newest first. Within a market the id orders exactly; across markets it
	// does not order at all — round 3 of a market deployed today is newer
	// than round 900 of one deployed in June — so the cross-market comparison
	// is on the block the round was last touched at.
	sort.Slice(rounds, func(i, j int) bool {
		if rounds[i].Market != rounds[j].Market {
			return rounds[i].LastBlock > rounds[j].LastBlock
		}
		return rounds[i].RoundID > rounds[j].RoundID
	})

	// Per market rather than once for the listing. Rake, entry cutoff and
	// minimum side pool are constructor arguments, and the demo market is
	// deliberately configured differently from the Chainlink one — so one set
	// of params applied to a mixed listing would put the wrong rake on the
	// odds of every row from the other market.
	markets := make([]string, 0, len(rounds))
	for _, round := range rounds {
		markets = append(markets, round.Market)
	}
	params, degraded, firstErr := s.marketParamsForAll(ctx, markets)

	out := make([]roundJSON, 0, len(rounds))
	for _, round := range rounds {
		p, ok := params[round.Market]
		if !ok {
			continue
		}
		out = append(out, renderRound(round, p, now))
	}

	// Only a failure when there was something to render and none of it could
	// be. An empty listing with nothing degraded is a legitimate empty answer.
	if len(out) == 0 && firstErr != nil {
		serverError(w, "read market params", firstErr)
		return
	}

	writeJSON(w, http.StatusOK, roundsResponse{
		ChainID:      s.cfg.ChainID,
		IndexedBlock: s.indexedBlock(ctx),
		AsOf:         now,
		Rounds:       out,
		Degraded:     degraded,
	})
}

// marketParamsForAll resolves the params of every distinct market in one pass.
//
// It returns what it could read, the markets it could not, and the first
// failure. Not the first error alone, which is what the callers used to do:
// GHO-51 made round history span deployments on purpose, so a listing
// legitimately contains markets this process has never watched, and one of
// them being unreadable took down every other market's data with it —
// including settled history that needs no live chain read to be listed.
//
// The first error is kept so the caller can still classify the failure when
// *nothing* could be rendered: serverError tells a rate limit from a bug by
// inspecting it, and a synthesised error would lose that.
func (s *Server) marketParamsForAll(ctx context.Context, markets []string) (map[string]protocol.MarketParams, []string, error) {
	return partitionMarketParams(markets, func(market string) (protocol.MarketParams, error) {
		return s.marketParamsFor(ctx, market)
	})
}

// partitionMarketParams is the whole of the above that is worth testing.
//
// Split out because `Server.reader` is a concrete *protocol.Reader with no
// interface behind it, so "what happens when the second of three markets
// fails" cannot be arranged through the Server without inventing one. A
// function taking a lookup needs no such ceremony and has no other dependency.
func partitionMarketParams(
	markets []string,
	lookup func(string) (protocol.MarketParams, error),
) (map[string]protocol.MarketParams, []string, error) {
	out := make(map[string]protocol.MarketParams, len(markets))
	var degraded []string
	var firstErr error

	for _, market := range markets {
		if _, done := out[market]; done {
			continue
		}
		if slices.Contains(degraded, market) {
			continue
		}

		params, err := lookup(market)
		if err != nil {
			// Warn, not error: one market being unreadable is now a partial
			// answer rather than a failure, and paging someone for it would
			// be paging them for a degraded response that worked.
			slog.Warn("read market params", "market", market, "err", err)
			degraded = append(degraded, market)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		out[market] = params
	}

	// Sorted so the field is stable across requests. An unstable list looks
	// like markets flapping when it is only map iteration order.
	slices.Sort(degraded)
	return out, degraded, firstErr
}

type positionJSON struct {
	Round roundJSON `json:"round"`

	UpStake    string `json:"upStake"`
	DownStake  string `json:"downStake"`
	TotalStake string `json:"totalStake"`
	// Claimable is what this account could collect right now, computed by the
	// same arithmetic the contract uses. Zero for a losing position, for an
	// unresolved round, and once claimed.
	Claimable     string    `json:"claimable"`
	Claimed       bool      `json:"claimed"`
	ClaimedAmount string    `json:"claimedAmount"`
	Leveraged     bool      `json:"leveraged"`
	OpenedAt      time.Time `json:"openedAt"`
}

type positionsResponse struct {
	Address      string    `json:"address"`
	ChainID      int64     `json:"chainId"`
	IndexedBlock uint64    `json:"indexedBlock"`
	AsOf         time.Time `json:"asOf"`

	// Split rather than one list with a flag, because the two are read for
	// different reasons: Open is "what am I in right now", History is "what
	// happened". A caller wanting both still gets one request.
	Open    []positionJSON `json:"open"`
	History []positionJSON `json:"history"`

	// Degraded names markets that could not be described, so a short listing
	// says so instead of quietly being a short listing. Omitted when empty:
	// an absent field and an empty array would mean the same thing, and only
	// one of them makes the common response smaller.
	Degraded []string `json:"degraded,omitempty"`
}

// handlePositions returns one address's round positions, open and historical.
func (s *Server) handlePositions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	address, ok := pathAddress(w, r)
	if !ok {
		return
	}
	limit := clampLimit(r.URL.Query().Get("limit"))

	market, ok := queryMarket(w, r)
	if !ok {
		return
	}

	refs, err := s.store.RoundsForAccount(ctx, s.cfg.ChainID, address, market, limit)
	if err != nil {
		serverError(w, "list account rounds", err)
		return
	}
	// Every event of those rounds, not only this account's: the payout
	// depends on the whole pool, so a position read from its own stake alone
	// could not say what it is worth.
	events, err := s.store.RoundEventsByRefs(ctx, s.cfg.ChainID, refs)
	if err != nil {
		serverError(w, "read round events", err)
		return
	}

	now := time.Now().UTC()
	// Keyed by the pair. Keyed by id alone, a position in the demo market's
	// round 7 would be rendered against the BTC market's round 7 — same
	// number, different bet, and every figure on it wrong.
	rounds := map[ledger.RoundRef]ledger.Round{}
	for _, round := range ledger.Project(events) {
		rounds[ledger.RoundRef{Market: round.Market, RoundID: round.RoundID}] = round
	}

	response := positionsResponse{
		Address:      address,
		ChainID:      s.cfg.ChainID,
		IndexedBlock: s.indexedBlock(ctx),
		AsOf:         now,
		Open:         []positionJSON{},
		History:      []positionJSON{},
	}

	positions := ledger.ProjectPositions(events, address)

	// Resolved once for the whole answer, before anything is rendered. This
	// lookup used to sit inside the loop and return on its first failure,
	// which is how one unreadable market took down a whole account's history
	// — and why an address with no positions returned 200 for the same
	// request that 500'd for an address with some (runbook Part 7.71).
	markets := make([]string, 0, len(positions))
	for _, position := range positions {
		markets = append(markets, position.Market)
	}
	params, degraded, firstErr := s.marketParamsForAll(ctx, markets)

	for _, position := range positions {
		round, ok := rounds[ledger.RoundRef{Market: position.Market, RoundID: position.RoundID}]
		if !ok {
			// Unreachable: the position was folded from the same events. Skip
			// rather than render a position with no round beside it.
			continue
		}
		p, ok := params[round.Market]
		if !ok {
			// Named in Degraded, not dropped silently. Under-reporting
			// somebody's history without saying so is the worse failure.
			continue
		}
		rendered := renderPosition(position, round, p, now)
		if round.Status == ledger.StatusResolved || round.Status == ledger.StatusVoid {
			response.History = append(response.History, rendered)
			continue
		}
		response.Open = append(response.Open, rendered)
	}

	if len(response.Open) == 0 && len(response.History) == 0 && firstErr != nil {
		serverError(w, "read market params", firstErr)
		return
	}
	response.Degraded = degraded

	writeJSON(w, http.StatusOK, response)
}

func renderRound(round ledger.Round, params protocol.MarketParams, now time.Time) roundJSON {
	status := string(round.Status)
	nowUnix := now.Unix()
	open, lock := round.OpenTime.Unix(), round.LockTime.Unix()

	return roundJSON{
		Market:    round.Market,
		ID:        round.RoundID,
		Status:    status,
		Phase:     string(finance.PhaseOf(status, open, lock, params.EntryCutoff, nowUnix)),
		EntryOpen: finance.EntryIsOpen(status, open, lock, params.EntryCutoff, nowUnix),

		OpenTime:  round.OpenTime,
		LockTime:  round.LockTime,
		CloseTime: round.CloseTime,

		UpPool:    round.UpPool.String(),
		DownPool:  round.DownPool.String(),
		TotalPool: round.TotalPool().String(),
		UpOdds:    finance.Odds(round.UpPool, round.UpPool, round.DownPool, params.Rake).String(),
		DownOdds:  finance.Odds(round.DownPool, round.UpPool, round.DownPool, params.Rake).String(),

		LockPrice:  decimalOrNil(round.LockPrice),
		ClosePrice: decimalOrNil(round.ClosePrice),
		Winner:     round.Winner,
		RakeTaken:  decimalOrNil(round.RakeTaken),
		VoidReason: round.VoidReason,
		Question:   renderQuestion(round.Question),

		LastBlock: round.LastBlock,
	}
}

func renderPosition(p ledger.AccountPosition, round ledger.Round, params protocol.MarketParams, now time.Time) positionJSON {
	claimable := finance.Claimable(
		finance.Position{UpStake: p.UpStake, DownStake: p.DownStake, Claimed: p.Claimed},
		string(round.Status), round.Winner, round.UpPool, round.DownPool, round.RakeTaken,
	)

	return positionJSON{
		Round:         renderRound(round, params, now),
		UpStake:       p.UpStake.String(),
		DownStake:     p.DownStake.String(),
		TotalStake:    p.TotalStake().String(),
		Claimable:     claimable.String(),
		Claimed:       p.Claimed,
		ClaimedAmount: p.ClaimedAmount.String(),
		Leveraged:     p.Leveraged,
		OpenedAt:      p.OpenedAt,
	}
}

// marketParamsFor reads one market's immutables, which protocol.Reader caches
// per market.
func (s *Server) marketParamsFor(ctx context.Context, market string) (protocol.MarketParams, error) {
	reader, err := s.chainReader()
	if err != nil {
		return s.storedMarketParams(ctx, market, err)
	}
	return reader.MarketParamsFor(ctx, market)
}

// storedMarketParams answers from Postgres alone, for a process that has no
// chain to ask (GHO-88).
//
// This is what makes booting without a chain worth anything. The Reader's own
// tiering already consults the store — but only once a Reader exists, and one
// cannot be built without a dialled client. Without this, a process that booted
// through a provider outage would 503 every round while the three numbers it
// needs to render them sit in `market_params`.
//
// Only for errChainUnavailable. A deployment with no contracts configured has
// no business rendering a market's odds from rows some earlier configuration
// left behind, and answering "not configured" keeps that visible.
func (s *Server) storedMarketParams(ctx context.Context, market string, cause error) (protocol.MarketParams, error) {
	if !errors.Is(cause, errChainUnavailable) || s.params == nil {
		return protocol.MarketParams{}, cause
	}
	if market == "" {
		// The primary market, spelled the way the Reader would have.
		// config.Load guarantees one when the indexer is enabled; checked
		// anyway because an index panic here would be a 500 in an outage.
		if len(s.cfg.Indexer.MarketAddresses) == 0 {
			return protocol.MarketParams{}, cause
		}
		market = s.cfg.Indexer.MarketAddresses[0]
	}
	key := common.HexToAddress(market).Hex()

	stored, found, err := s.params.MarketParams(ctx, s.cfg.ChainID, key)
	if err != nil {
		return protocol.MarketParams{}, err
	}
	if !found {
		// Never read while the chain was up, so there is nothing to serve —
		// and the reason is still the chain, not the database.
		return protocol.MarketParams{}, cause
	}
	return stored, nil
}

// queryMarket reads an optional `?market=` filter, normalised to the
// checksummed spelling the indexer writes.
//
// A malformed address is rejected rather than ignored. Ignoring it would
// answer with every market's rounds, which is not a narrower answer to the
// question asked — it is a wider one, and the caller has no way to tell.
func queryMarket(w http.ResponseWriter, r *http.Request) (string, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("market"))
	if raw == "" {
		return "", true
	}
	address, err := auth.NormalizeAddress(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid market address")
		return "", false
	}
	return address, true
}

// marketParams reads the primary market's immutables, which protocol.Reader
// caches.
func (s *Server) marketParams(ctx context.Context) (protocol.MarketParams, error) {
	reader, err := s.chainReader()
	if err != nil {
		// The API can serve indexed rounds with no chain connection, but not
		// the odds or the phase, both of which need the market's immutables.
		// Answered from the store if they were ever read; otherwise reported
		// rather than defaulted, because guessed protocol parameters produce
		// plausible wrong numbers, which is worse than an error.
		return s.storedMarketParams(ctx, "", err)
	}
	return reader.MarketParams(ctx)
}

// indexedBlock reports how far the indexer has read, or zero if it never has.
//
// Never an error: this is context on a response that has already succeeded,
// and failing the whole request because the staleness marker could not be
// read would be the tail wagging the dog.
func (s *Server) indexedBlock(ctx context.Context) uint64 {
	// The deployment's own stream (GHO-51). Reading the chain-scoped name
	// would find whichever deployment last wrote under it, which after a
	// redeploy is the previous one — so the freshness marker on every
	// response would be describing a different set of contracts than the
	// response.
	stream := ledger.StreamName(
		s.cfg.ChainID,
		ledger.DeploymentOf(
			s.cfg.Indexer.VaultAddress, s.cfg.Indexer.PoolAddress, s.cfg.Indexer.MarketAddresses,
		),
	)
	cursor, found, err := s.store.LoadCursor(ctx, stream)
	if err != nil || !found {
		return 0
	}
	return cursor.LastBlock
}

// pathAddress reads and normalises an {address} path parameter.
//
// Normalised to the same EIP-55 checksummed form the indexer writes, because
// that is what the ledger's account column holds. A lowercase address from a
// URL bar would otherwise match nothing and return an empty, entirely
// plausible, wrong answer.
func pathAddress(w http.ResponseWriter, r *http.Request) (string, bool) {
	address, err := auth.NormalizeAddress(chi.URLParam(r, "address"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid address")
		return "", false
	}
	return address, true
}

func clampLimit(raw string) int {
	if raw == "" {
		return defaultRoundLimit
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return defaultRoundLimit
	}
	if n > maxRoundLimit {
		return maxRoundLimit
	}
	return n
}

func decimalOrNil(v *big.Int) *string {
	if v == nil {
		return nil
	}
	s := v.String()
	return &s
}
