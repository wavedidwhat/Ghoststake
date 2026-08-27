-- +goose Up

-- Indexes for the merged per-address activity feed (GHO-49).
--
-- The feed reads both tables for one account and merges them on the log's own
-- coordinates — (block_number, log_index, record_index) descending — because
-- that is the only total order over rows from two tables, and paging on
-- anything less than a total order repeats or drops rows at the boundary.
--
-- Each half therefore needs an index whose column order *is* that sort, or
-- Postgres reads every row the account ever produced and sorts them to return
-- twenty. That is fine at demo volumes and quietly stops being fine, which is
-- the kind of thing that is much cheaper to index now than to diagnose later.

-- The lending half. Partial on kind = 'flow' because the feed never reads a
-- balance entry: those hold index-scaled amounts, and a history row drawn
-- from a scaled amount reports a number the user never saw. Making that a
-- property of the index as well as of the query means the fast path and the
-- correct path are the same path.
CREATE INDEX ledger_entries_activity_idx
    ON ledger_entries (chain_id, account, block_number DESC, log_index DESC, record_index DESC)
    WHERE kind = 'flow';

-- The round half. `round_events_account_idx` exists but sorts by round_id,
-- which orders a user's positions within a market and does not order this
-- feed at all — a claim and a deposit have to interleave by block.
CREATE INDEX round_events_activity_idx
    ON round_events (chain_id, account, block_number DESC, log_index DESC, record_index DESC)
    WHERE account IS NOT NULL;

-- Superseded by ledger_entries_activity_idx, which leads with the same
-- account column and carries the chain and the tie-breaks as well. Dropped
-- rather than left: an unused index is write amplification on every insert
-- the indexer makes, forever, for a read nothing performs.
DROP INDEX ledger_entries_account_recent_idx;

-- +goose Down
CREATE INDEX ledger_entries_account_recent_idx ON ledger_entries (account, block_number DESC);
DROP INDEX round_events_activity_idx;
DROP INDEX ledger_entries_activity_idx;
