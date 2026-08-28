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
			record_index, contract, contract_address, event_name, kind, account,
			ledger, delta, counterparty
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
			e.RecordIndex, e.Contract, nullable(e.ContractAddress), e.EventName,
			e.Kind, e.Account, e.Ledger, e.Delta.String(), nullable(e.Counterparty),
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
// A balance is always scoped to one deployment's contracts (GHO-51).
//
// Without `contracts` these three queries sum across every deployment that has
// ever run on the chain: an old vault's shares added to a new vault's, an old
// pool's debt to a new pool's. One number, no error, and wrong in the direction
// that makes an insolvent position look healthy.
//
// Strict equality, not "or NULL". Rows written before migration 0009 carry no
// address and are stamped at preflight by attributeExistingEntries, so the only
// way to see a NULL here is a database with entries that no indexer has ever
// booted against — at which point returning nothing is the honest answer, and
// far better than adopting somebody else's rows on a guess.
func (s *Store) BalanceOf(
	ctx context.Context, chainID int64, account, ledger string, contracts []string,
) (*big.Int, error) {
	const q = `
		SELECT COALESCE(SUM(delta), 0)::TEXT
		FROM ledger_entries
		WHERE chain_id = $1 AND account = $2 AND ledger = $3 AND kind = 'balance'
		  AND contract_address = ANY($4)`

	var raw string
	if err := s.pool.QueryRow(ctx, q, chainID, account, ledger, contracts).Scan(&raw); err != nil {
		return nil, fmt.Errorf("balance of %s/%s: %w", account, ledger, err)
	}
	value, ok := new(big.Int).SetString(raw, 10)
	if !ok {
		return nil, fmt.Errorf("balance of %s/%s: cannot parse %q", account, ledger, raw)
	}
	return value, nil
}

// BalancesOf derives every book an account holds.
func (s *Store) BalancesOf(
	ctx context.Context, chainID int64, account string, contracts []string,
) (map[string]*big.Int, error) {
	const q = `
		SELECT ledger, SUM(delta)::TEXT
		FROM ledger_entries
		WHERE chain_id = $1 AND account = $2 AND kind = 'balance'
		  AND contract_address = ANY($3)
		GROUP BY ledger`

	rows, err := s.pool.Query(ctx, q, chainID, account, contracts)
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

// BorrowersByExposure lists every account carrying debt, largest first.
//
// The query GHO-42 needed and nothing had ever asked. `liquidate` is
// permissionless — that is what keeps the protocol solvent — but every view in
// the system was per-address, so a liquidator had to already know whose
// position was underwater before they could act on it. The incentive existed,
// the mechanism existed, and the discovery step did not.
//
// It comes from the ledger rather than the chain because the chain cannot
// answer it: there is no borrower enumeration on the pool, and reconstructing
// one means reading every Borrowed and Repaid log, which is the cost the
// indexer was built to remove.
//
// Scaled debt, not current debt. The scaled figure is what the ledger stores
// and is invariant under accrual, so ordering by it orders by exposure exactly
// — current debt is that number times an index shared by every borrower, and
// multiplying every row by the same constant does not reorder them.
//
// The ordering is what makes `limit` defensible rather than arbitrary. A cap
// has to fall somewhere, and it should fall on the smallest positions: a
// borrower with dust is not the one whose default matters, and a liquidator
// reading a truncated list should be missing the trivia rather than the risk.
func (s *Store) BorrowersByExposure(
	ctx context.Context, chainID int64, contracts []string, limit int,
) ([]string, error) {
	const q = `
		SELECT account
		FROM ledger_entries
		WHERE chain_id = $1 AND ledger = $2 AND kind = 'balance'
		  AND contract_address = ANY($3)
		GROUP BY account
		HAVING SUM(delta) > 0
		ORDER BY SUM(delta) DESC
		LIMIT $4`

	rows, err := s.pool.Query(ctx, q, chainID, ledger.DebtScaled, contracts, limit)
	if err != nil {
		return nil, fmt.Errorf("list borrowers: %w", err)
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var account string
		if err := rows.Scan(&account); err != nil {
			return nil, fmt.Errorf("scan borrower: %w", err)
		}
		out = append(out, account)
	}
	return out, rows.Err()
}

// AdoptCursor renames a stream, and refuses to overwrite.
//
// The GHO-51 rename could not live in the migration the way 0003's did: the
// new stream name carries the contract fingerprint, and SQL cannot know which
// contracts a process watches. So it happens at preflight, where it does.
//
// Returns false rather than erroring when there is nothing to adopt — a fresh
// database and an already-adopted one are both normal, and neither is a
// problem worth a boot failure.
func (s *Store) AdoptCursor(ctx context.Context, from, to string) (bool, error) {
	// `WHERE NOT EXISTS` rather than a plain rename. If something already sits
	// under the new name it is this deployment's real position, and the legacy
	// row is an older deployment's — clobbering it would move the cursor
	// backwards or forwards to a block this deployment never read.
	const q = `
		UPDATE indexer_cursor SET stream = $2, updated_at = now()
		WHERE stream = $1
		  AND NOT EXISTS (SELECT 1 FROM indexer_cursor WHERE stream = $2)`

	tag, err := s.pool.Exec(ctx, q, from, to)
	if err != nil {
		return false, fmt.Errorf("adopt cursor %s -> %s: %w", from, to, err)
	}
	return tag.RowsAffected() > 0, nil
}

// UnattributedEntries counts rows written before entries carried an address.
func (s *Store) UnattributedEntries(ctx context.Context, chainID int64) (int64, error) {
	const q = `
		SELECT count(*) FROM ledger_entries
		WHERE chain_id = $1 AND contract_address IS NULL`

	var n int64
	if err := s.pool.QueryRow(ctx, q, chainID).Scan(&n); err != nil {
		return 0, fmt.Errorf("count unattributed entries: %w", err)
	}
	return n, nil
}

// AttributeEntries fills the address in for one named contract.
//
// Keyed on the contract *name*, which is the only thing those rows carry — and
// it is enough here in a way it is not in general. `ledger_entries` only ever
// holds vault and pool events (round events go to their own table, which has
// carried a market address since GHO-43), and there is exactly one vault and
// one pool per deployment. So "every row that says CollateralVault was written
// by this deployment's vault" is a fact whenever a single deployment's rows are
// present, which is the only situation this runs in.
func (s *Store) AttributeEntries(ctx context.Context, chainID int64, contract, address string) (int64, error) {
	const q = `
		UPDATE ledger_entries SET contract_address = $3
		WHERE chain_id = $1 AND contract = $2 AND contract_address IS NULL`

	tag, err := s.pool.Exec(ctx, q, chainID, contract, address)
	if err != nil {
		return 0, fmt.Errorf("attribute %s entries: %w", contract, err)
	}
	return tag.RowsAffected(), nil
}
