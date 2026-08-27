-- +goose Up

-- Which market a round event belongs to.
--
-- `round_events` was keyed by (chain_id, round_id), and round ids restart at 1
-- in every ParimutuelRound. So the table could hold exactly one market's
-- history: pointing the indexer at a second one would merge two markets' round
-- 7 into a single round and sum pools that have nothing to do with each other.
-- That is worse than the blindness it replaces, because a wrong pool total is
-- harder to notice than a missing one.
--
-- The identity of a round is now the pair. This column is the other half.
--
-- Empty string means "written before this column existed", the same convention
-- `indexer_cursor.contracts` already uses. The address is not knowable from
-- SQL — it lives in the process's configuration — so the backfill happens at
-- the indexer's preflight, where the configured market list is in scope and
-- can be checked: exactly one market configured means those rows are
-- unambiguously its, and more than one means refusing to guess. See
-- Indexer.Preflight.
ALTER TABLE round_events ADD COLUMN market TEXT NOT NULL DEFAULT '';

-- Projecting a round reads every event for it in log order. The read is now
-- per market, so the market has to lead the id or the index cannot serve it.
DROP INDEX round_events_round_idx;
CREATE INDEX round_events_round_idx
    ON round_events (chain_id, market, round_id, block_number, log_index);

-- A user's positions, grouped per (market, round) and ordered by the newest
-- block each was touched at. `block_number` is carried so that max() is served
-- from the index rather than a heap fetch per group.
DROP INDEX round_events_account_idx;
CREATE INDEX round_events_account_idx
    ON round_events (chain_id, account, market, round_id DESC, block_number)
    WHERE account IS NOT NULL;

-- Deliberately NOT touched: round_events_log_unique (chain_id, tx_hash,
-- log_index, record_index). A log is emitted by exactly one contract, so those
-- four columns are already unique across every market — adding `market` would
-- widen a uniqueness constraint that is doing its job, and a wider unique key
-- accepts duplicates a narrower one rejects. Idempotency on replay is the one
-- property here that must not get weaker.

-- +goose Down
DROP INDEX round_events_account_idx;
CREATE INDEX round_events_account_idx
    ON round_events (chain_id, account, round_id DESC)
    WHERE account IS NOT NULL;

DROP INDEX round_events_round_idx;
CREATE INDEX round_events_round_idx
    ON round_events (chain_id, round_id, block_number, log_index);

ALTER TABLE round_events DROP COLUMN market;
