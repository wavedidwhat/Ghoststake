package store

import (
	"context"
	"errors"
	"fmt"
	"math/big"

	"github.com/jackc/pgx/v5"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// Store implements ledger.Repository. Asserted at compile time so a drift
// between the port and this adapter is a build failure, not a runtime one.
var _ ledger.Repository = (*Store)(nil)

// AppendEntries writes entries and advances the cursor in one transaction.
//
// Both or neither: a cursor that moved past rows that were never written
// would skip them permanently, since nothing revisits a block the cursor has
// already passed.
func (s *Store) AppendEntries(ctx context.Context, entries []ledger.Entry, cursor ledger.Cursor) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const insert = `
		INSERT INTO ledger_entries (
			chain_id, block_number, block_hash, block_time, tx_hash, log_index,
			entry_index, contract, event_name, kind, account, ledger, delta,
			counterparty
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		-- Idempotent by construction: replaying a range is a no-op rather
		-- than a double count.
		ON CONFLICT (chain_id, tx_hash, log_index, entry_index) DO NOTHING`

	batch := &pgx.Batch{}
	for _, e := range entries {
		var counterparty any
		if e.Counterparty != "" {
			counterparty = e.Counterparty
		}
		batch.Queue(insert,
			e.ChainID, e.BlockNumber, e.BlockHash, e.BlockTime, e.TxHash, e.LogIndex,
			e.EntryIndex, e.Contract, e.EventName, e.Kind, e.Account, e.Ledger,
			e.Delta.String(), counterparty,
		)
	}
	if batch.Len() > 0 {
		results := tx.SendBatch(ctx, batch)
		for range entries {
			if _, err := results.Exec(); err != nil {
				_ = results.Close()
				return fmt.Errorf("insert entry: %w", err)
			}
		}
		if err := results.Close(); err != nil {
			return fmt.Errorf("close batch: %w", err)
		}
	}

	const upsertCursor = `
		INSERT INTO indexer_cursor (stream, chain_id, last_block, last_block_hash, updated_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (stream) DO UPDATE
		SET last_block = EXCLUDED.last_block,
		    last_block_hash = EXCLUDED.last_block_hash,
		    chain_id = EXCLUDED.chain_id,
		    updated_at = now()`
	if _, err := tx.Exec(ctx, upsertCursor, cursor.Stream, cursor.ChainID, cursor.LastBlock, cursor.LastHash); err != nil {
		return fmt.Errorf("upsert cursor: %w", err)
	}

	return tx.Commit(ctx)
}

// LoadCursor returns the stream's position, or ok=false if it has never run.
func (s *Store) LoadCursor(ctx context.Context, stream string) (ledger.Cursor, bool, error) {
	const q = `SELECT stream, chain_id, last_block, last_block_hash FROM indexer_cursor WHERE stream = $1`

	var c ledger.Cursor
	err := s.pool.QueryRow(ctx, q, stream).Scan(&c.Stream, &c.ChainID, &c.LastBlock, &c.LastHash)
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
	return tag.RowsAffected(), nil
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
