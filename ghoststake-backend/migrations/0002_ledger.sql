-- +goose Up

-- Append-only event ledger.
--
-- Balances are never stored. They are derived by summing `delta` over an
-- account's entries, which makes every figure traceable to the log that
-- produced it and makes a wrong balance a query bug rather than a corrupted
-- row that has to be reconciled by hand.
--
-- Rows are immutable once written. The only deletion is a reorg rollback,
-- which removes whole blocks rather than editing anything.
CREATE TABLE ledger_entries (
    id           BIGSERIAL PRIMARY KEY,

    -- Provenance. Every entry names the log it was derived from.
    chain_id     BIGINT      NOT NULL,
    block_number BIGINT      NOT NULL,
    block_hash   TEXT        NOT NULL,
    block_time   TIMESTAMPTZ NOT NULL,
    tx_hash      TEXT        NOT NULL,
    log_index    INTEGER     NOT NULL,
    -- One log can produce several entries (a transfer debits one account and
    -- credits another), so the log's own coordinates are not unique on their
    -- own. This disambiguates them.
    entry_index  SMALLINT    NOT NULL,

    contract     TEXT        NOT NULL,
    event_name   TEXT        NOT NULL,

    -- 'balance' entries sum to a book. 'flow' entries are history only and
    -- must never be summed into one — see the note on ledger names below.
    kind         TEXT        NOT NULL CHECK (kind IN ('balance', 'flow')),
    account      TEXT        NOT NULL,
    ledger       TEXT        NOT NULL,
    -- uint256 needs 78 digits; signed because entries debit as well as credit.
    delta        NUMERIC(78, 0) NOT NULL,

    -- The other party, where the event names one: a repayer, a liquidator,
    -- the counterparty of a share transfer.
    counterparty TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Idempotency. A replayed range, a restart mid-batch, or an overlapping
    -- backfill all re-insert the same rows, and this turns that into a no-op
    -- rather than a double count.
    CONSTRAINT ledger_entries_log_unique UNIQUE (chain_id, tx_hash, log_index, entry_index)
);

-- Balance derivation: sum deltas for one account's book.
CREATE INDEX ledger_entries_balance_idx
    ON ledger_entries (chain_id, account, ledger)
    WHERE kind = 'balance';

-- Reorg rollback deletes by block, and history reads by recency.
CREATE INDEX ledger_entries_block_idx ON ledger_entries (chain_id, block_number);
CREATE INDEX ledger_entries_account_recent_idx ON ledger_entries (account, block_number DESC);

-- How far the indexer has read.
--
-- `last_block_hash` is what makes reorg detection possible: on each cycle the
-- indexer re-reads that block and compares. A different hash means the chain
-- moved under us and everything from that height is suspect.
CREATE TABLE indexer_cursor (
    stream          TEXT        PRIMARY KEY,
    chain_id        BIGINT      NOT NULL,
    last_block      BIGINT      NOT NULL,
    last_block_hash TEXT        NOT NULL DEFAULT '',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE indexer_cursor;
DROP TABLE ledger_entries;
