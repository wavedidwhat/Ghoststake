package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"

	"github.com/jackc/pgx/v5"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// Store implements ledger.Repository. Asserted at compile time so a drift
// between the port and this adapter is a build failure, not a runtime one.
var _ ledger.Repository = (*Store)(nil)

// Append writes one indexed range and advances the cursor in one transaction.
//
// All or nothing, across both tables: a cursor that moved past rows that were
// never written would skip them permanently, since nothing revisits a block
// the cursor has already passed. And a round position committed without the
// borrow that funded it — they arrive in the same transaction on the leveraged
// path — would be a stake with no debt behind it until the next cycle.
func (s *Store) Append(ctx context.Context, batch ledger.Batch, cursor ledger.Cursor) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const insertEntry = `
		INSERT INTO ledger_entries (
			chain_id, block_number, block_hash, block_time, tx_hash, log_index,
			record_index, contract, event_name, kind, account, ledger, delta,
			counterparty
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		-- Idempotent by construction: replaying a range is a no-op rather
		-- than a double count.
		ON CONFLICT (chain_id, tx_hash, log_index, record_index) DO NOTHING`

	const insertRound = `
		INSERT INTO round_events (
			chain_id, block_number, block_hash, block_time, tx_hash, log_index,
			record_index, contract, event_name, market, round_id, account, side,
			amount, data
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
		ON CONFLICT (chain_id, tx_hash, log_index, record_index) DO NOTHING`

	queued := &pgx.Batch{}
	for _, e := range batch.Entries {
		queued.Queue(insertEntry,
			e.ChainID, e.BlockNumber, e.BlockHash, e.BlockTime, e.TxHash, e.LogIndex,
			e.RecordIndex, e.Contract, e.EventName, e.Kind, e.Account, e.Ledger,
			e.Delta.String(), nullable(e.Counterparty),
		)
	}
	for _, e := range batch.Rounds {
		var amount any
		if e.Amount != nil {
			amount = e.Amount.String()
		}
		data, err := json.Marshal(e.Data)
		if err != nil {
			return fmt.Errorf("encode round event data: %w", err)
		}
		queued.Queue(insertRound,
			e.ChainID, e.BlockNumber, e.BlockHash, e.BlockTime, e.TxHash, e.LogIndex,
			e.RecordIndex, e.Contract, e.EventName, e.Market, e.RoundID, nullable(e.Account),
			nullable(e.Side), amount, data,
		)
	}
	if queued.Len() > 0 {
		results := tx.SendBatch(ctx, queued)
		for range queued.Len() {
			if _, err := results.Exec(); err != nil {
				_ = results.Close()
				return fmt.Errorf("insert record: %w", err)
			}
		}
		if err := results.Close(); err != nil {
			return fmt.Errorf("close batch: %w", err)
		}
	}

	// The decoder version is written here, in the same transaction that
	// advances the position — which is what makes a replay happen exactly
	// once. Stamping it separately, before or after, would leave a window
	// where a crash means either replaying forever or never replaying at all.
	const upsertCursor = `
		INSERT INTO indexer_cursor (stream, chain_id, last_block, last_block_hash, contracts, decoders, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, now())
		ON CONFLICT (stream) DO UPDATE
		SET last_block = EXCLUDED.last_block,
		    last_block_hash = EXCLUDED.last_block_hash,
		    chain_id = EXCLUDED.chain_id,
		    contracts = EXCLUDED.contracts,
		    decoders = EXCLUDED.decoders,
		    updated_at = now()`
	if _, err := tx.Exec(ctx, upsertCursor,
		cursor.Stream, cursor.ChainID, cursor.LastBlock, cursor.LastHash,
		cursor.Contracts, cursor.Decoders); err != nil {
		return fmt.Errorf("upsert cursor: %w", err)
	}

	return tx.Commit(ctx)
}

// LoadCursor returns the stream's position, or ok=false if it has never run.
func (s *Store) LoadCursor(ctx context.Context, stream string) (ledger.Cursor, bool, error) {
	const q = `
		SELECT stream, chain_id, last_block, last_block_hash, contracts, decoders
		FROM indexer_cursor WHERE stream = $1`

	var c ledger.Cursor
	err := s.pool.QueryRow(ctx, q, stream).
		Scan(&c.Stream, &c.ChainID, &c.LastBlock, &c.LastHash, &c.Contracts, &c.Decoders)
	if errors.Is(err, pgx.ErrNoRows) {
		return ledger.Cursor{}, false, nil
	}
	if err != nil {
		return ledger.Cursor{}, false, fmt.Errorf("load cursor: %w", err)
	}
	return c, true, nil
}

// RollbackFrom deletes every entry at or above a block height and rewinds the
// cursor to just below it. Used when a reorg is detected.
//
// Deleting whole blocks rather than editing rows is what keeps the table
// append-only in spirit: an entry is either the chain's history or it is not
// history at all.
func (s *Store) RollbackFrom(ctx context.Context, chainID int64, stream string, fromBlock uint64) (int64, error) {
	// `fromBlock - 1` below is unsigned: zero would wrap the cursor to the
	// top of uint64 rather than rewinding it to the start.
	if fromBlock == 0 {
		return 0, fmt.Errorf("rollback: fromBlock must be greater than zero")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`DELETE FROM ledger_entries WHERE chain_id = $1 AND block_number >= $2`, chainID, fromBlock)
	if err != nil {
		return 0, fmt.Errorf("delete entries: %w", err)
	}
	// Round events rewind on exactly the same rule. Missing this table would
	// leave a resolved round that the chain no longer resolved.
	roundTag, err := tx.Exec(ctx,
		`DELETE FROM round_events WHERE chain_id = $1 AND block_number >= $2`, chainID, fromBlock)
	if err != nil {
		return 0, fmt.Errorf("delete round events: %w", err)
	}

	// The hash is cleared rather than guessed: the indexer re-reads the block
	// it rewinds to on the next cycle, and an empty hash means "unverified"
	// rather than a stale one that would look like a match.
	if _, err := tx.Exec(ctx,
		`UPDATE indexer_cursor SET last_block = $2, last_block_hash = '', updated_at = now() WHERE stream = $1`,
		stream, fromBlock-1); err != nil {
		return 0, fmt.Errorf("rewind cursor: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected() + roundTag.RowsAffected(), nil
}

// RecordsInRange counts what we already hold for a block range, across both
// derived tables.
//
// The one number the indexer cannot get from the chain. A re-read that comes
// back with no logs looks exactly like a quiet stretch of blocks; the only
// thing that distinguishes it from an RPC that has pruned its log index is
// whether we already have rows in that range. See
// Indexer.assertLogsStillServed for what is done with the answer.
//
// Both ends inclusive, matching the eth_getLogs range it is compared against —
// an off-by-one here would compare two different ranges and call the
// difference pruning.
func (s *Store) RecordsInRange(ctx context.Context, chainID int64, fromBlock, toBlock uint64) (int64, error) {
	const q = `
		SELECT (SELECT count(*) FROM ledger_entries
		         WHERE chain_id = $1 AND block_number BETWEEN $2 AND $3)
		     + (SELECT count(*) FROM round_events
		         WHERE chain_id = $1 AND block_number BETWEEN $2 AND $3)`

	var n int64
	if err := s.pool.QueryRow(ctx, q, chainID, fromBlock, toBlock).Scan(&n); err != nil {
		return 0, fmt.Errorf("records in range %d-%d: %w", fromBlock, toBlock, err)
	}
	return n, nil
}

// ReplayFrom rewinds a cursor without deleting a single row.
//
// The counterpart to RollbackFrom, and the difference is what the rows mean.
// A reorg says they were never history: they have to go. A decoder change
// says they are correct but incomplete — the new records are ones the old
// decoder derived and discarded — so deleting them would destroy good data in
// order to re-derive it from an RPC that may not serve those logs any more.
//
// Re-reading over them is safe because every insert is idempotent on
// (chain, tx, log index, record index): what exists is a no-op, what is new
// is written.
//
// The block hash is cleared for the same reason the rollback clears it: the
// cursor no longer sits where that hash was taken, and a stale one would make
// the next reorg check compare against the wrong block and see a false match.
func (s *Store) ReplayFrom(ctx context.Context, stream string, fromBlock uint64) error {
	if fromBlock == 0 {
		// `fromBlock - 1` is unsigned: zero would wrap the cursor to the top
		// of uint64 rather than rewinding it, and the indexer would then sit
		// forever waiting for a block height that will never arrive.
		return fmt.Errorf("replay: fromBlock must be greater than zero")
	}
	_, err := s.pool.Exec(ctx,
		`UPDATE indexer_cursor SET last_block = $2, last_block_hash = '', updated_at = now()
		 WHERE stream = $1`, stream, fromBlock-1)
	if err != nil {
		return fmt.Errorf("replay from %d: %w", fromBlock, err)
	}
	return nil
}

// nullable maps an empty string to SQL NULL, so an absent counterparty,
// account or side is stored as "there is none" rather than as an empty
// string that every query would then have to exclude by hand.
func nullable(v string) any {
	if v == "" {
		return nil
	}
	return v
}

// BalanceOf derives one book for one account by summing its entries.
//
// Nothing is cached and no balance is stored, so this cannot disagree with
// the entries that produced it. Flow ledgers are excluded at the query, not
// left to the caller to remember.
func (s *Store) BalanceOf(ctx context.Context, chainID int64, account, ledger string) (*big.Int, error) {
	const q = `
		SELECT COALESCE(SUM(delta), 0)::TEXT
		FROM ledger_entries
		WHERE chain_id = $1 AND account = $2 AND ledger = $3 AND kind = 'balance'`

	var raw string
	if err := s.pool.QueryRow(ctx, q, chainID, account, ledger).Scan(&raw); err != nil {
		return nil, fmt.Errorf("balance of %s/%s: %w", account, ledger, err)
	}
	value, ok := new(big.Int).SetString(raw, 10)
	if !ok {
		return nil, fmt.Errorf("balance of %s/%s: cannot parse %q", account, ledger, raw)
	}
	return value, nil
}

// BalancesOf derives every book an account holds.
func (s *Store) BalancesOf(ctx context.Context, chainID int64, account string) (map[string]*big.Int, error) {
	const q = `
		SELECT ledger, SUM(delta)::TEXT
		FROM ledger_entries
		WHERE chain_id = $1 AND account = $2 AND kind = 'balance'
		GROUP BY ledger`

	rows, err := s.pool.Query(ctx, q, chainID, account)
	if err != nil {
		return nil, fmt.Errorf("balances of %s: %w", account, err)
	}
	defer rows.Close()

	out := map[string]*big.Int{}
	for rows.Next() {
		var ledger, raw string
		if err := rows.Scan(&ledger, &raw); err != nil {
			return nil, err
		}
		value, ok := new(big.Int).SetString(raw, 10)
		if !ok {
			return nil, fmt.Errorf("balances of %s: cannot parse %q", account, raw)
		}
		out[ledger] = value
	}
	return out, rows.Err()
}

// CountEntries is used by the tests and the readiness probe.
func (s *Store) CountEntries(ctx context.Context, chainID int64) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM ledger_entries WHERE chain_id = $1`, chainID).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count entries: %w", err)
	}
	return n, nil
}
