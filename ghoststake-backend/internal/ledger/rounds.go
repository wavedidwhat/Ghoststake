package ledger

import (
	"fmt"
	"math/big"
	"sort"
	"time"
)

// Round event names, matching the contract's events exactly.
//
// Written out rather than passed through as free strings so a renamed event
// is a compile error in the projection instead of a status that silently
// stops arriving.
const (
	RoundOpened = "RoundOpened"
	// RoundStrikeSet carries the level a round asks about, emitted when it
	// opens (GHO-79). Its own event rather than a field on RoundOpened, so
	// markets deployed before the change keep decoding unchanged — they
	// simply never emit it, and their strike still arrives at lock.
	RoundStrikeSet = "RoundStrikeSet"
	PositionTaken  = "PositionTaken"
	RoundLocked    = "RoundLocked"
	RoundResolved  = "RoundResolved"
	RoundVoided    = "RoundVoided"
	Claimed        = "Claimed"

	// The lifecycle of a question, emitted by an EventRoundOracle rather than
	// by the market (GHO-80, carried up in GHO-91).
	//
	// They fold into the same Round as the market's own events, keyed by the
	// same (market, round) pair, because they are facts about that round: it
	// is a round whose close price is an outcome somebody claimed. Keeping
	// them in a second projection would mean every read path that wants to
	// show a round having to join two things that describe one.
	Proposed   = "Proposed"
	Challenged = "Challenged"
	Ruled      = "Ruled"
	Finalised  = "Finalised"
	Abandoned  = "Abandoned"
	MarketSet  = "MarketSet"
)

// Outcome names, as EventRoundOracle's `Outcome` enum orders them.
const (
	OutcomeNone = "none"
	OutcomeYes  = "yes"
	OutcomeNo   = "no"
)

// OutcomeFromEnum maps the oracle's uint8 to a name.
//
// An error rather than a default, for the reason SideFromEnum gives: a value
// this does not know means the enum grew, and guessing would show everyone
// the wrong answer to a question with money on it.
func OutcomeFromEnum(v uint8) (string, error) {
	switch v {
	case 0:
		return OutcomeNone, nil
	case 1:
		return OutcomeYes, nil
	case 2:
		return OutcomeNo, nil
	}
	return "", fmt.Errorf("unknown outcome %d", v)
}

// Sides, as the contract's `Side` enum orders them.
const (
	SideUp   = "up"
	SideDown = "down"
)

// SideFromEnum maps the contract's uint8 to a name.
func SideFromEnum(v uint8) (string, error) {
	switch v {
	case 0:
		return SideUp, nil
	case 1:
		return SideDown, nil
	}
	return "", fmt.Errorf("unknown side %d", v)
}

// RoundEvent is one round-lifecycle fact, derived from one log.
//
// # Why this is not an Entry
//
// An Entry is a signed delta that sums to a balance. Most of what a round
// emits does not sum to anything: a lock price, a winner and a void reason
// are statements about the round, and the last one written is the truth.
// Forcing them into the delta shape would mean inventing a book they belong
// to and a number to add to it.
//
// What they share is the append-only rule. A round's current state is never
// stored — it is folded from its events on read (see Project), so a status is
// always traceable to the log that set it and a reorg rollback removes it by
// block like everything else.
type RoundEvent struct {
	Provenance

	// Market is the address of the ParimutuelRound that emitted this, EIP-55
	// checksummed.
	//
	// Load-bearing, not decoration. Round ids restart at 1 in every market, so
	// `RoundID` alone is not an identity — it names round 7 in as many markets
	// as are deployed. Without this the projections below fold two unrelated
	// markets' round 7 into one round, summing pools that have nothing to do
	// with each other. That is worse than the single-market blindness it
	// replaced, because a wrong number is harder to notice than a missing one.
	//
	// The emitting contract's address rather than a configured label: it comes
	// off the log, so it cannot disagree with where the event came from.
	Market string

	RoundID uint64
	// Account is the user the event concerns, or "" for round-level events.
	Account string
	// Side is up/down for a position, "" otherwise.
	Side string
	// Amount is the staked or claimed amount; nil where the event has none.
	Amount *big.Int

	// Data carries the fields only some events have — prices, times, the
	// winner, the void reason, the funder or payout recipient — as decimal or
	// plain strings.
	//
	// A map rather than a wide struct of mostly-null columns: these are read
	// back to be displayed, not to be summed or filtered on, and the set
	// grows every time the contract gains an event.
	Data map[string]string
}

// RoundRef identifies one round: which market, and which round in it.
//
// The pair is the identity. A bare round id is ambiguous across markets, and
// every read path that used one — recent rounds, an account's rounds, the
// event fetch behind both — returned a set that silently spanned markets.
type RoundRef struct {
	Market  string
	RoundID uint64
}

// Batch is everything one indexed range produced.
//
// The two kinds are written together, in one transaction, with one cursor
// move. A round position and the borrow that funded it can arrive in the same
// transaction, and committing one without the other would show a user a stake
// with no debt behind it, or the reverse.
type Batch struct {
	Entries []Entry
	Rounds  []RoundEvent
}

func (b Batch) Len() int { return len(b.Entries) + len(b.Rounds) }

// RoundStatus is a round's state, folded from its events.
type RoundStatus string

const (
	StatusOpen     RoundStatus = "open"
	StatusLocked   RoundStatus = "locked"
	StatusResolved RoundStatus = "resolved"
	StatusVoid     RoundStatus = "void"
)

// Round is the projection: what the events add up to.
type Round struct {
	ChainID   int64
	Market    string
	RoundID   uint64
	Status    RoundStatus
	OpenTime  time.Time
	LockTime  time.Time
	CloseTime time.Time

	UpPool   *big.Int
	DownPool *big.Int

	LockPrice  *big.Int
	ClosePrice *big.Int
	// Winner is set only once resolved.
	Winner string
	// RakeTaken is the protocol's cut, set only once resolved.
	RakeTaken *big.Int
	// VoidReason is the contract's own reason string, set only on a void.
	VoidReason string

	// Question is the lifecycle of an externally-answered round, or nil for
	// a price round (GHO-91).
	//
	// A pointer rather than flat fields so that "this round settles a
	// question" and "this round's question has not been claimed yet" are
	// different states. Flattened, a zero proposer would mean both.
	Question *QuestionState

	// LastBlock is the height the newest event folded into this came from,
	// which is what tells a caller how stale the projection is.
	LastBlock uint64
}

func (r Round) TotalPool() *big.Int { return new(big.Int).Add(r.UpPool, r.DownPool) }

// Project folds a round's events into its current state.
//
// Order matters and is not the order the events arrive in a slice: they are
// sorted by (block, log index) first, so a batch assembled from several
// ranges, or a caller that queried without an ORDER BY, still folds to the
// same answer. Ordering by height rather than by trusting the input is the
// difference between a projection and a race.
func Project(events []RoundEvent) []Round {
	sorted := make([]RoundEvent, len(events))
	copy(sorted, events)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].BlockNumber != sorted[j].BlockNumber {
			return sorted[i].BlockNumber < sorted[j].BlockNumber
		}
		return sorted[i].LogIndex < sorted[j].LogIndex
	})

	// Keyed by (market, round), never by round id alone. Round ids restart at
	// 1 in every market, so keying on the id merges round 7 of the BTC market
	// with round 7 of the demo market and sums their pools together.
	byRef := map[RoundRef]*Round{}
	var order []RoundRef
	for _, e := range sorted {
		ref := RoundRef{Market: e.Market, RoundID: e.RoundID}
		r, ok := byRef[ref]
		if !ok {
			r = &Round{
				ChainID:  e.ChainID,
				Market:   e.Market,
				RoundID:  e.RoundID,
				UpPool:   new(big.Int),
				DownPool: new(big.Int),
			}
			byRef[ref] = r
			order = append(order, ref)
		}
		if e.BlockNumber > r.LastBlock {
			r.LastBlock = e.BlockNumber
		}
		applyRoundEvent(r, e)
	}

	out := make([]Round, 0, len(order))
	for _, ref := range order {
		out = append(out, *byRef[ref])
	}
	return out
}

func applyRoundEvent(r *Round, e RoundEvent) {
	switch e.EventName {
	case RoundOpened:
		r.Status = StatusOpen
		r.OpenTime = unixField(e.Data, "openTime")
		r.LockTime = unixField(e.Data, "lockTime")
		r.CloseTime = unixField(e.Data, "closeTime")

	case PositionTaken:
		if e.Amount == nil {
			return
		}
		// Pool totals are summed here rather than read from the contract, so
		// the frontend does not have to. A position is only ever added — the
		// contract has no un-stake — so a sum is the whole story.
		switch e.Side {
		case SideUp:
			r.UpPool = new(big.Int).Add(r.UpPool, e.Amount)
		case SideDown:
			r.DownPool = new(big.Int).Add(r.DownPool, e.Amount)
		}

	case RoundStrikeSet:
		// The strike, known while entry is still open. RoundLocked sets the
		// same field later with the same value, which is deliberate: a market
		// deployed before GHO-79 only ever learns it there.
		r.LockPrice = bigField(e.Data, "strikePrice")

	case RoundLocked:
		r.Status = StatusLocked
		r.LockPrice = bigField(e.Data, "lockPrice")

	case RoundResolved:
		r.Status = StatusResolved
		r.ClosePrice = bigField(e.Data, "closePrice")
		r.Winner = e.Data["winner"]
		r.RakeTaken = bigField(e.Data, "rakeTaken")

	case RoundVoided:
		// A void is terminal and overrides whatever the round was, which is
		// why it is folded last-writer-wins like the others rather than
		// guarded: the contract cannot emit anything after it.
		r.Status = StatusVoid
		r.VoidReason = e.Data["reason"]

	case MarketSet:
		// The oracle being pointed at this round. Nothing to show, but it is
		// what makes the round a question rather than a price, and it always
		// precedes a claim — `setMarket` is refused once anything has been
		// proposed.
		r.question().Oracle = e.Data["oracle"]

	case Proposed:
		q := r.question()
		q.State = QuestionProposed
		q.Proposer = e.Account
		q.Outcome = e.Data["outcome"]
		q.EvidenceURI = e.Data["evidenceURI"]
		q.EvidenceDigest = e.Data["evidenceDigest"]
		q.ProposerStake = bigField(e.Data, "proposerStake")
		q.ChallengeClosesAt = unixField(e.Data, "challengeClosesAt")
		q.ProposedAt = e.BlockTime

	case Challenged:
		q := r.question()
		q.State = QuestionChallenged
		q.Challenger = e.Account
		q.RulingDueAt = unixField(e.Data, "rulingDueAt")
		q.ChallengedAt = e.BlockTime

	case Ruled:
		q := r.question()
		q.Arbiter = e.Account
		q.Outcome = e.Data["outcome"]
		q.ReasonURI = e.Data["reasonURI"]
		q.PaidTo = e.Data["paid"]
		q.RuledAt = e.BlockTime

	case Finalised:
		// The one that decides the answer. `Ruled` carries the arbiter's
		// verdict and `Proposed` the claim, but only this says the oracle
		// will now answer — and a round can reach it by either path.
		q := r.question()
		q.State = QuestionFinal
		q.Outcome = e.Data["outcome"]

	case Abandoned:
		// Terminal and unanswerable: nobody ruled in time, both bonds went
		// back, and the round is now waiting for its refund.
		q := r.question()
		q.State = QuestionAbandoned
		q.AbandonedAt = unixField(e.Data, "at")
	}
}

// question returns this round's question state, creating it on first use.
//
// Created lazily rather than always, so `Question == nil` keeps meaning "this
// is a price round" for the many rounds that are.
func (r *Round) question() *QuestionState {
	if r.Question == nil {
		r.Question = &QuestionState{State: QuestionOpen}
	}
	return r.Question
}

// QuestionLifecycle is where an externally-answered round's outcome has got
// to, folded from the oracle's events. It mirrors EventRoundOracle's `State`.
type QuestionLifecycle string

const (
	QuestionOpen       QuestionLifecycle = "open"
	QuestionProposed   QuestionLifecycle = "proposed"
	QuestionChallenged QuestionLifecycle = "challenged"
	QuestionFinal      QuestionLifecycle = "final"
	QuestionAbandoned  QuestionLifecycle = "abandoned"
)

// QuestionState is the claim on a round's outcome and everything anyone would
// need to check it.
//
// Every field here exists to answer "should I argue with this?" — who said
// what happened, against which document, how long is left, and whether they
// had money riding on the answer. A resolution panel that showed only the
// outcome would be the operator call this whole mechanism replaces.
type QuestionState struct {
	// Oracle is the EventRoundOracle that answers this round, from MarketSet.
	Oracle string

	State   QuestionLifecycle
	Outcome string

	Proposer       string
	ProposedAt     time.Time
	EvidenceURI    string
	EvidenceDigest string

	// ProposerStake is what the proposer had staked in this very round at the
	// moment they claimed its outcome, in the market's own units. Zero is a
	// real answer — they held nothing — and so is a proposer who held a lot:
	// it is disclosed rather than forbidden, because a ban only moves the
	// position to another address.
	ProposerStake *big.Int

	// ChallengeClosesAt is when an unchallenged claim becomes final. The
	// number the whole design rests on: it is what makes "nobody argued" mean
	// something.
	ChallengeClosesAt time.Time

	Challenger   string
	ChallengedAt time.Time
	RulingDueAt  time.Time

	Arbiter   string
	RuledAt   time.Time
	ReasonURI string
	// PaidTo is whose side the ruling took, and so who received both bonds.
	PaidTo string

	AbandonedAt time.Time
}

func bigField(data map[string]string, key string) *big.Int {
	v, ok := new(big.Int).SetString(data[key], 10)
	if !ok {
		return nil
	}
	return v
}

func unixField(data map[string]string, key string) time.Time {
	v := bigField(data, key)
	if v == nil {
		return time.Time{}
	}
	return time.Unix(v.Int64(), 0).UTC()
}

// AccountPosition is one account's involvement in one round, folded from the
// events that name it.
type AccountPosition struct {
	ChainID   uint64
	Market    string
	RoundID   uint64
	Account   string
	UpStake   *big.Int
	DownStake *big.Int

	// Claimed and ClaimedAmount come from the Claimed event, which is the
	// only thing that says a payout was collected. The contract does not
	// reduce a stake on claim — it sets a flag — so a stake that still reads
	// full is not evidence that nothing was paid out.
	Claimed       bool
	ClaimedAmount *big.Int

	// Leveraged is set when someone other than the account funded the stake,
	// which in practice means the borrow-to-position router opened it with
	// borrowed money. The payout then routes back through the router to
	// repay the debt before anything reaches the user.
	Leveraged bool

	OpenedAt time.Time
	LastTime time.Time
	// LastBlock is the newest block folded in, for staleness.
	LastBlock uint64
}

func (p AccountPosition) TotalStake() *big.Int {
	return new(big.Int).Add(p.UpStake, p.DownStake)
}

// ProjectPositions folds an account's round events into one position per
// round, newest round first.
//
// Only events naming this account are considered, so the caller may pass a
// round's whole history — that is in fact what the API does, because the same
// query feeds both the round projection and the position.
func ProjectPositions(events []RoundEvent, account string) []AccountPosition {
	sorted := make([]RoundEvent, 0, len(events))
	for _, e := range events {
		if e.Account == account && account != "" {
			sorted = append(sorted, e)
		}
	}
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].BlockNumber != sorted[j].BlockNumber {
			return sorted[i].BlockNumber < sorted[j].BlockNumber
		}
		return sorted[i].LogIndex < sorted[j].LogIndex
	})

	// Keyed by (market, round) for the same reason Project is: an account
	// holding round 7 in two markets has two positions, and merging them would
	// report one stake that is the sum of two unrelated bets.
	byRef := map[RoundRef]*AccountPosition{}
	var order []RoundRef
	for _, e := range sorted {
		ref := RoundRef{Market: e.Market, RoundID: e.RoundID}
		p, ok := byRef[ref]
		if !ok {
			p = &AccountPosition{
				Market:        e.Market,
				RoundID:       e.RoundID,
				Account:       account,
				UpStake:       new(big.Int),
				DownStake:     new(big.Int),
				ClaimedAmount: new(big.Int),
				OpenedAt:      e.BlockTime,
			}
			byRef[ref] = p
			order = append(order, ref)
		}
		p.LastTime = e.BlockTime
		if e.BlockNumber > p.LastBlock {
			p.LastBlock = e.BlockNumber
		}

		switch e.EventName {
		case PositionTaken:
			if e.Amount == nil {
				continue
			}
			switch e.Side {
			case SideUp:
				p.UpStake = new(big.Int).Add(p.UpStake, e.Amount)
			case SideDown:
				p.DownStake = new(big.Int).Add(p.DownStake, e.Amount)
			}
			if funder := e.Data["funder"]; funder != "" && funder != account {
				p.Leveraged = true
			}
		case Claimed:
			p.Claimed = true
			if e.Amount != nil {
				p.ClaimedAmount = new(big.Int).Add(p.ClaimedAmount, e.Amount)
			}
		}
	}

	// Newest round first: a positions list is read top-down and the round
	// someone is in right now is the one they came to look at.
	//
	// Across markets the id is no longer a clock — round 3 of a market
	// deployed today is newer than round 900 of one deployed in June — so the
	// tie-break is the block the position was last touched at, which is
	// comparable between markets. The id only orders within one market, where
	// it is exact.
	out := make([]AccountPosition, 0, len(order))
	for i := len(order) - 1; i >= 0; i-- {
		out = append(out, *byRef[order[i]])
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Market != out[j].Market {
			return out[i].LastBlock > out[j].LastBlock
		}
		return out[i].RoundID > out[j].RoundID
	})
	return out
}
