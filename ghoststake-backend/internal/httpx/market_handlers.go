package httpx

import (
	"context"
	"math/big"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/wavedidwhat/ghoststake/internal/auth"
	"github.com/wavedidwhat/ghoststake/internal/finance"
	"github.com/wavedidwhat/ghoststake/internal/ledger"
	"github.com/wavedidwhat/ghoststake/internal/protocol"
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

	LastBlock uint64 `json:"lastBlock"`
}

type roundsResponse struct {
	ChainID int64 `json:"chainId"`
	// IndexedBlock is how far the indexer has read. A client comparing it
	// with the chain head knows whether "no rounds" means none exist or that
	// the backfill has not reached them yet.
	IndexedBlock uint64      `json:"indexedBlock"`
	AsOf         time.Time   `json:"asOf"`
	Rake         string      `json:"rake"`
	EntryCutoff  int64       `json:"entryCutoffSeconds"`
	Rounds       []roundJSON `json:"rounds"`
}

// handleRounds lists recent rounds with their pool split.
//
// The pools are summed from indexed positions, not read from the contract.
// That is the point of indexing them: a listing of twenty rounds would
// otherwise be forty `eth_call`s, per viewer, per refresh.
func (s *Server) handleRounds(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	limit := clampLimit(r.URL.Query().Get("limit"))

	ids, err := s.store.RecentRoundIDs(ctx, s.cfg.ChainID, limit)
	if err != nil {
		serverError(w, "list rounds", err)
		return
	}
	events, err := s.store.RoundEventsByIDs(ctx, s.cfg.ChainID, ids)
	if err != nil {
		serverError(w, "read round events", err)
		return
	}
	params, err := s.marketParams(ctx)
	if err != nil {
		serverError(w, "read market params", err)
		return
	}

	now := time.Now().UTC()
	rounds := ledger.Project(events)
	// Newest first, by round id. Project preserves the order events were
	// first seen in, which is usually the same thing and is not guaranteed
	// to be — a round opened earlier can have its first indexed event later
	// after a rollback. Sorting on the id says what is actually meant.
	sort.Slice(rounds, func(i, j int) bool { return rounds[i].RoundID > rounds[j].RoundID })

	out := make([]roundJSON, 0, len(rounds))
	for _, round := range rounds {
		out = append(out, renderRound(round, params, now))
	}

	writeJSON(w, http.StatusOK, roundsResponse{
		ChainID:      s.cfg.ChainID,
		IndexedBlock: s.indexedBlock(ctx),
		AsOf:         now,
		Rake:         params.Rake.String(),
		EntryCutoff:  params.EntryCutoff,
		Rounds:       out,
	})
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
}

// handlePositions returns one address's round positions, open and historical.
func (s *Server) handlePositions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	address, ok := pathAddress(w, r)
	if !ok {
		return
	}
	limit := clampLimit(r.URL.Query().Get("limit"))

	ids, err := s.store.RoundIDsForAccount(ctx, s.cfg.ChainID, address, limit)
	if err != nil {
		serverError(w, "list account rounds", err)
		return
	}
	// Every event of those rounds, not only this account's: the payout
	// depends on the whole pool, so a position read from its own stake alone
	// could not say what it is worth.
	events, err := s.store.RoundEventsByIDs(ctx, s.cfg.ChainID, ids)
	if err != nil {
		serverError(w, "read round events", err)
		return
	}
	params, err := s.marketParams(ctx)
	if err != nil {
		serverError(w, "read market params", err)
		return
	}

	now := time.Now().UTC()
	rounds := map[uint64]ledger.Round{}
	for _, round := range ledger.Project(events) {
		rounds[round.RoundID] = round
	}

	response := positionsResponse{
		Address:      address,
		ChainID:      s.cfg.ChainID,
		IndexedBlock: s.indexedBlock(ctx),
		AsOf:         now,
		Open:         []positionJSON{},
		History:      []positionJSON{},
	}

	for _, position := range ledger.ProjectPositions(events, address) {
		round, ok := rounds[position.RoundID]
		if !ok {
			// Unreachable: the position was folded from the same events. Skip
			// rather than render a position with no round beside it.
			continue
		}
		rendered := renderPosition(position, round, params, now)
		if round.Status == ledger.StatusResolved || round.Status == ledger.StatusVoid {
			response.History = append(response.History, rendered)
			continue
		}
		response.Open = append(response.Open, rendered)
	}

	writeJSON(w, http.StatusOK, response)
}

func renderRound(round ledger.Round, params protocol.MarketParams, now time.Time) roundJSON {
	status := string(round.Status)
	nowUnix := now.Unix()
	open, lock := round.OpenTime.Unix(), round.LockTime.Unix()

	return roundJSON{
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

// marketParams reads the market's immutables, which protocol.Reader caches.
func (s *Server) marketParams(ctx context.Context) (protocol.MarketParams, error) {
	if s.reader == nil {
		// The API can serve indexed rounds with no chain connection, but not
		// the odds or the phase, both of which need the market's immutables.
		// Reported rather than defaulted: guessed protocol parameters produce
		// plausible wrong numbers, which is worse than an error.
		return protocol.MarketParams{}, errNoChainReader
	}
	return s.reader.MarketParams(ctx)
}

// indexedBlock reports how far the indexer has read, or zero if it never has.
//
// Never an error: this is context on a response that has already succeeded,
// and failing the whole request because the staleness marker could not be
// read would be the tail wagging the dog.
func (s *Server) indexedBlock(ctx context.Context) uint64 {
	cursor, found, err := s.store.LoadCursor(ctx, ledger.StreamName(s.cfg.ChainID))
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
