package store

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// The round reads are deliberately two steps: pick the round ids first, then
// fetch every event for those rounds.
//
// A single query with a LIMIT over the events would cut a round in half —
// returning some of its positions and not others — and the projection would
// then report a pool total that is simply wrong, with nothing to indicate it.
// Choosing whole rounds and then reading all of their events makes a partial
// read impossible rather than unlikely.

// RecentRounds returns the newest rounds across every indexed market.
//
// (market, round_id) pairs rather than bare ids. A bare id is ambiguous the
// moment a second market exists, and the ambiguity is silent: round 7 comes
// back once for two markets, and the events fetched for it span both.
//
// `market = ”` narrows to one market; empty means every market.
func (s *Store) RecentRounds(ctx context.Context, chainID int64, market string, limit int) ([]ledger.RoundRef, error) {
	// Ordered by the newest block each round was touched at, NOT by round id.
	//
	// The id is a clock within a market and nothing at all across them: a
	// market deployed today is on round 3 while one from June is on round 900,
	// so `ORDER BY round_id DESC LIMIT 20` returns twenty of June's rounds and
	// none of today's. That is the same blindness this issue exists to remove,
	// reintroduced one layer down and harder to see — the endpoint answers,
	// the rows are real, and a whole market is missing.
	//
	// The block height is comparable between markets because it is the same
	// chain. Ties break on the id so the order is total and a page is stable.
	//
	// One query with an optional filter rather than two, because the two
	// would drift: the ordering and the grouping are the subtle parts and
	// keeping one copy of them is what stops the filtered path quietly
	// answering a different question.
	const q = `
		SELECT market, round_id
		FROM round_events
		WHERE chain_id = $1 AND ($2 = '' OR market = $2)
		GROUP BY market, round_id
		ORDER BY max(block_number) DESC, round_id DESC, market
		LIMIT $3`
	return s.roundRefs(ctx, q, chainID, market, limit)
}

// RoundsForAccount returns the newest rounds this account appears in, in any
// market.
func (s *Store) RoundsForAccount(ctx context.Context, chainID int64, account, market string, limit int) ([]ledger.RoundRef, error) {
	// Same ordering argument as RecentRounds: most recently touched first, so
	// a user's position in a freshly deployed market is not pushed off the
	// page by an older market's higher round numbers.
	const q = `
		SELECT market, round_id
		FROM round_events
		WHERE chain_id = $1 AND account = $2 AND ($3 = '' OR market = $3)
		GROUP BY market, round_id
		ORDER BY max(block_number) DESC, round_id DESC, market
		LIMIT $4`
	return s.roundRefs(ctx, q, chainID, account, market, limit)
}

func (s *Store) roundRefs(ctx context.Context, q string, args ...any) ([]ledger.RoundRef, error) {
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("round refs: %w", err)
	}
	defer rows.Close()

	var out []ledger.RoundRef
	for rows.Next() {
		var ref ledger.RoundRef
		if err := rows.Scan(&ref.Market, &ref.RoundID); err != nil {
			return nil, err
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}

// RoundEventsByIDs returns every event for the named rounds, in log order.
//
// Ordered here as well as in ledger.Project. The projection sorts what it is
// given because it cannot trust its caller; this orders because an ORDER BY
// on an indexed column costs nothing and makes the rows readable in a psql
// session when something looks wrong.
func (s *Store) RoundEventsByRefs(ctx context.Context, chainID int64, refs []ledger.RoundRef) ([]ledger.RoundEvent, error) {
	if len(refs) == 0 {
		return nil, nil
	}

	// Joined against the pairs rather than filtered on two independent ANY
	// lists. Two lists would match the *cross product* — asking for round 7 of
	// market A and round 9 of market B would also return round 9 of A and
	// round 7 of B, and those extra rounds project perfectly well, so the
	// response would be longer than the limit with nothing to indicate why.
	const q = `
		SELECT e.block_number, e.block_hash, e.block_time, e.tx_hash, e.log_index, e.record_index,
		       e.contract, e.event_name, e.market, e.round_id,
		       COALESCE(e.account, ''), COALESCE(e.side, ''), e.amount::TEXT, e.data
		FROM round_events e
		JOIN unnest($2::text[], $3::bigint[]) AS want(market, round_id)
		  ON e.market = want.market AND e.round_id = want.round_id
		WHERE e.chain_id = $1
		ORDER BY e.block_number, e.log_index, e.record_index`

	markets := make([]string, len(refs))
	// Converted to int64 because that is what Postgres' bigint[] is, and pgx
	// encodes a []uint64 as numeric[] — which never matches the bigint column
	// and fails as a type error rather than as an empty result.
	ids := make([]int64, len(refs))
	for i, ref := range refs {
		markets[i] = ref.Market
		ids[i] = int64(ref.RoundID)
	}

	rows, err := s.pool.Query(ctx, q, chainID, markets, ids)
	if err != nil {
		return nil, fmt.Errorf("round events: %w", err)
	}
	defer rows.Close()

	var out []ledger.RoundEvent
	for rows.Next() {
		e := ledger.RoundEvent{Provenance: ledger.Provenance{ChainID: chainID}}
		var amount *string
		var data []byte
		if err := rows.Scan(
			&e.BlockNumber, &e.BlockHash, &e.BlockTime, &e.TxHash, &e.LogIndex, &e.RecordIndex,
			&e.Contract, &e.EventName, &e.Market, &e.RoundID, &e.Account, &e.Side, &amount, &data,
		); err != nil {
			return nil, fmt.Errorf("scan round event: %w", err)
		}
		// Postgres hands back a timestamptz in the session's zone, which is
		// whatever the container's TZ happens to be. Normalised here so every
		// timestamp the API emits is UTC — a response mixing "Z" and "+01:00"
		// is one a client has to parse carefully to compare two of its own
		// fields.
		e.BlockTime = e.BlockTime.UTC()

		if amount != nil {
			v, ok := new(big.Int).SetString(*amount, 10)
			if !ok {
				return nil, fmt.Errorf("round %d: cannot parse amount %q", e.RoundID, *amount)
			}
			e.Amount = v
		}
		if len(data) > 0 {
			if err := json.Unmarshal(data, &e.Data); err != nil {
				return nil, fmt.Errorf("round %d: decode data: %w", e.RoundID, err)
			}
		}
		if e.Data == nil {
			e.Data = map[string]string{}
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// CountRoundEvents backs the live test, which asserts the market's events
// reached the table rather than only the lending ones.
func (s *Store) CountRoundEvents(ctx context.Context, chainID int64) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM round_events WHERE chain_id = $1`, chainID).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count round events: %w", err)
	}
	return n, nil
}

// UnattributedRoundEvents counts rows written before the market column
// existed, which carry an empty market.
//
// Same convention as `indexer_cursor.contracts`: empty means "predates the
// column", not "belongs to a market called nothing". The migration cannot set
// it — the address lives in the process's configuration, not in SQL — so the
// repair happens at the indexer's preflight, which is where the configured
// market list is in scope.
func (s *Store) UnattributedRoundEvents(ctx context.Context, chainID int64) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM round_events WHERE chain_id = $1 AND market = ''`, chainID).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count unattributed round events: %w", err)
	}
	return n, nil
}

// AttributeRoundEvents assigns a market to every row that has none.
//
// Only ever called with a single configured market, where the attribution is
// a fact rather than a guess: those rows were indexed by a process watching
// exactly one ParimutuelRound, so that is the one they came from.
func (s *Store) AttributeRoundEvents(ctx context.Context, chainID int64, market string) (int64, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE round_events SET market = $2 WHERE chain_id = $1 AND market = ''`, chainID, market)
	if err != nil {
		return 0, fmt.Errorf("attribute round events: %w", err)
	}
	return tag.RowsAffected(), nil
}
