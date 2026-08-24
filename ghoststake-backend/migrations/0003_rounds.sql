-- +goose Up

-- The ledger's "one log, several records" column is now shared with the round
-- events below, so it is named for records rather than for entries.
ALTER TABLE ledger_entries RENAME COLUMN entry_index TO record_index;

-- The indexer watches the market as well as the vault and the pool, on one
-- stream. Renaming the cursor rather than starting a new one is what stops
-- the whole backfill being replayed from the deploy block on first boot after
-- this migration: the vault and pool ranges already read stay read.
UPDATE indexer_cursor
SET stream = 'ghoststake:' || split_part(stream, ':', 2)
WHERE stream LIKE 'lending:%';

-- Append-only round history.
--
-- Separate from ledger_entries because the two are different shapes, not
-- because they are different subjects. A ledger entry is a signed delta that
-- sums to a balance. Most of what a round emits — a lock price, a winner, a
-- void reason — does not sum to anything: it is a statement about the round,
-- and the newest one is the truth. Squeezing those into a delta column would
-- mean inventing a book they belong to and a number to add to it.
--
-- What the two tables do share is the rule: rows are immutable once written,
-- every row names the log it came from, and the only deletion is a reorg
-- rollback that removes whole blocks.
--
-- A round's current state is never stored. It is folded from these rows on
-- read (ledger.Project), so a status is always traceable to the log that set
-- it, and pool totals are a SUM over the positions rather than a mirror of
-- the contract's storage that could silently drift from it.
CREATE TABLE round_events (
    id           BIGSERIAL PRIMARY KEY,

    -- Provenance, identical in meaning to ledger_entries.
    chain_id     BIGINT      NOT NULL,
    block_number BIGINT      NOT NULL,
    block_hash   TEXT        NOT NULL,
    block_time   TIMESTAMPTZ NOT NULL,
    tx_hash      TEXT        NOT NULL,
    log_index    INTEGER     NOT NULL,
    record_index SMALLINT    NOT NULL,

    contract     TEXT        NOT NULL,
    event_name   TEXT        NOT NULL,

    round_id     BIGINT      NOT NULL,
    -- NULL for round-level events (opened, locked, resolved, voided), set for
    -- the two that name a user (a position, a claim).
    account      TEXT,
    side         TEXT        CHECK (side IN ('up', 'down')),
    -- uint256 needs 78 digits. Unsigned in practice — a stake is never
    -- negative and the contract has no un-stake — but left NUMERIC rather
    -- than constrained, because a CHECK here would turn a decoder bug into a
    -- write that fails silently on retry rather than one that is visible.
    amount       NUMERIC(78, 0),

    -- The fields only some events carry: prices, times, the winner, the void
    -- reason, the funder, the payout recipient. JSONB rather than a dozen
    -- mostly-null columns, because these are read back to be displayed, not
    -- summed or filtered on.
    data         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Idempotency, the same as the ledger's: a replayed range is a no-op.
    CONSTRAINT round_events_log_unique UNIQUE (chain_id, tx_hash, log_index, record_index)
);

-- Projecting one round, or a page of rounds, reads every event for those
-- rounds in log order. This index is that read.
CREATE INDEX round_events_round_idx
    ON round_events (chain_id, round_id, block_number, log_index);

-- A user's positions: their events, newest round first.
CREATE INDEX round_events_account_idx
    ON round_events (chain_id, account, round_id DESC)
    WHERE account IS NOT NULL;

-- Reorg rollback deletes by block.
CREATE INDEX round_events_block_idx ON round_events (chain_id, block_number);

-- +goose Down
DROP TABLE round_events;

UPDATE indexer_cursor
SET stream = 'lending:' || split_part(stream, ':', 2)
WHERE stream LIKE 'ghoststake:%';

ALTER TABLE ledger_entries RENAME COLUMN record_index TO entry_index;
