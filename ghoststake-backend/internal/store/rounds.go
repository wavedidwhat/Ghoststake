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

// RecentRoundIDs returns the newest round ids, highest first.
func (s *Store) RecentRoundIDs(ctx context.Context, chainID int64, limit int) ([]uint64, error) {
	const q = `
		SELECT DISTINCT round_id
		FROM round_events
		WHERE chain_id = $1
		ORDER BY round_id DESC
		LIMIT $2`
	return s.roundIDs(ctx, q, chainID, limit)
}

// RoundIDsForAccount returns the newest rounds this account appears in.
func (s *Store) RoundIDsForAccount(ctx context.Context, chainID int64, account string, limit int) ([]uint64, error) {
	const q = `
		SELECT DISTINCT round_id
		FROM round_events
		WHERE chain_id = $1 AND account = $2
		ORDER BY round_id DESC
		LIMIT $3`
	return s.roundIDs(ctx, q, chainID, account, limit)
}

func (s *Store) roundIDs(ctx context.Context, q string, args ...any) ([]uint64, error) {
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("round ids: %w", err)
	}
	defer rows.Close()

	var out []uint64
	for rows.Next() {
		var id uint64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// RoundEventsByIDs returns every event for the named rounds, in log order.
//
// Ordered here as well as in ledger.Project. The projection sorts what it is
// given because it cannot trust its caller; this orders because an ORDER BY
// on an indexed column costs nothing and makes the rows readable in a psql
// session when something looks wrong.
func (s *Store) RoundEventsByIDs(ctx context.Context, chainID int64, ids []uint64) ([]ledger.RoundEvent, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	const q = `
		SELECT block_number, block_hash, block_time, tx_hash, log_index, record_index,
		       contract, event_name, round_id, COALESCE(account, ''), COALESCE(side, ''),
		       amount::TEXT, data
		FROM round_events
		WHERE chain_id = $1 AND round_id = ANY($2)
		ORDER BY block_number, log_index, record_index`

	// Converted to int64 because that is what Postgres' bigint[] is, and pgx
	// encodes a []uint64 as numeric[] — which never matches the bigint column
	// and fails as a type error rather than as an empty result.
	keys := make([]int64, len(ids))
	for i, id := range ids {
		keys[i] = int64(id)
	}

	rows, err := s.pool.Query(ctx, q, chainID, keys)
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
			&e.Contract, &e.EventName, &e.RoundID, &e.Account, &e.Side, &amount, &data,
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
