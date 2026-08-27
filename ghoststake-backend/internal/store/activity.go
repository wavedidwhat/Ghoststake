package store

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// ActivityFor returns one address's history across both tables, newest first.
//
// # One query, not two
//
// The lending rows and the round rows are merged in SQL rather than fetched
// separately and interleaved in Go. Two queries would each need their own
// limit, and there is no limit pair that is correct: ask for twenty of each
// and a user who only ever lent gets twenty rows from one and nothing from
// the other, while a user who did both gets forty rows to sort and throw half
// away — and the half thrown away is exactly the page boundary, so the cursor
// handed back would skip whatever the other table had just past it.
//
// # Ordered on the log, not on the clock
//
// (block_number, log_index, record_index) descending. Not block_time: a block
// stamps every log in it with the same second, so a timestamp sort is not a
// total order, and a page boundary landing inside a block would include or
// exclude its neighbours depending on how the sort happened to break the tie
// that time. The log's coordinates are unique by construction — the
// uniqueness constraint on both tables is built from them.
//
// # Flow entries only
//
// `kind = 'flow'` is in the query, not left to the caller. Balance entries
// hold index-scaled amounts (see ledger.Activity), and one reaching a history
// page shows a completed transaction whose figure moves on reload. A filter a
// caller has to remember is a filter that will eventually be forgotten.
//
// A limit of `limit+1` is read so the caller can tell "this is the last page"
// from "there is exactly one more row"; the extra row is dropped and reported
// as the next cursor instead.
func (s *Store) ActivityFor(
	ctx context.Context,
	chainID int64,
	account string,
	after *ledger.ActivityCursor,
	limit int,
) (events []ledger.Activity, next *ledger.ActivityCursor, err error) {
	// The cursor is passed as four parameters — a flag and three coordinates —
	// rather than as a sentinel block of zero. Block zero is a real height,
	// and a sentinel that is also a legal value is a bug waiting for the one
	// deployment whose genesis block carries a log.
	//
	// Row-value comparison `(a,b,c) < ($2,$3,$4)` rather than the unrolled
	// three-way OR. It is the same comparison the ORDER BY makes, written
	// once, so the two cannot drift into disagreeing about what "older" means.
	const q = `
		SELECT block_number, block_hash, block_time, tx_hash, log_index, record_index,
		       contract, event_name, source, book, amount, counterparty,
		       market, round_id, side, data
		FROM (
			SELECT block_number, block_hash, block_time, tx_hash, log_index, record_index,
			       contract, event_name,
			       'ledger'                  AS source,
			       ledger                    AS book,
			       delta::TEXT               AS amount,
			       COALESCE(counterparty,'') AS counterparty,
			       ''                        AS market,
			       0::BIGINT                 AS round_id,
			       ''                        AS side,
			       '{}'::JSONB               AS data
			FROM ledger_entries
			WHERE chain_id = $1 AND account = $2 AND kind = 'flow'

			UNION ALL

			SELECT block_number, block_hash, block_time, tx_hash, log_index, record_index,
			       contract, event_name,
			       'round'                       AS source,
			       ''                            AS book,
			       COALESCE(amount::TEXT, '0')   AS amount,
			       ''                            AS counterparty,
			       market,
			       round_id,
			       COALESCE(side, '')            AS side,
			       data
			FROM round_events
			WHERE chain_id = $1 AND account = $2
		) merged
		WHERE NOT $3::BOOLEAN
		   OR (block_number, log_index, record_index) < ($4::BIGINT, $5::INTEGER, $6::SMALLINT)
		ORDER BY block_number DESC, log_index DESC, record_index DESC
		LIMIT $7`

	var (
		paging      = after != nil
		block       uint64
		logIndex    uint
		recordIndex int
	)
	if paging {
		block, logIndex, recordIndex = after.BlockNumber, after.LogIndex, after.RecordIndex
	}

	rows, err := s.pool.Query(ctx, q,
		chainID, account, paging, block, logIndex, recordIndex, limit+1)
	if err != nil {
		return nil, nil, fmt.Errorf("activity for %s: %w", account, err)
	}
	defer rows.Close()

	out := make([]ledger.Activity, 0, limit)
	for rows.Next() {
		a := ledger.Activity{Provenance: ledger.Provenance{ChainID: chainID}}
		var amount string
		var data []byte
		if err := rows.Scan(
			&a.BlockNumber, &a.BlockHash, &a.BlockTime, &a.TxHash, &a.LogIndex, &a.RecordIndex,
			&a.Contract, &a.EventName, &a.Source, &a.Ledger, &amount, &a.Counterparty,
			&a.Market, &a.RoundID, &a.Side, &data,
		); err != nil {
			return nil, nil, fmt.Errorf("scan activity: %w", err)
		}
		// Normalised to UTC for the reason RoundEventsByRefs does it: Postgres
		// hands back a timestamptz in the session's zone, and a response
		// mixing "Z" with "+01:00" is one a client has to parse carefully to
		// compare two of its own fields.
		a.BlockTime = a.BlockTime.UTC()

		value, ok := new(big.Int).SetString(amount, 10)
		if !ok {
			// Refused rather than defaulted to zero. A row whose amount could
			// not be read is a decoding bug, and rendering it as "0" puts a
			// wrong number in front of a user with nothing to indicate it.
			return nil, nil, fmt.Errorf("activity %s#%d: cannot parse amount %q",
				a.TxHash, a.LogIndex, amount)
		}
		a.Amount = value

		a.Data = map[string]string{}
		if len(data) > 0 {
			if err := json.Unmarshal(data, &a.Data); err != nil {
				return nil, nil, fmt.Errorf("activity %s#%d: decode data: %w",
					a.TxHash, a.LogIndex, err)
			}
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	// The extra row read above is the answer to "is there another page", and
	// it is dropped rather than returned. Returning limit+1 rows would make
	// every page one longer than asked for, which a client sizing a list on
	// the limit renders as a row that keeps appearing at the bottom.
	if len(out) > limit {
		out = out[:limit]
		cursor := out[len(out)-1].CursorOf()
		return out, &cursor, nil
	}
	return out, nil, nil
}
