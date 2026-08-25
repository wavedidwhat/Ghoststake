-- +goose Up

-- Which contracts a cursor's position was reached by reading.
--
-- The stream name is chain-scoped, so redeploying the contracts reuses the
-- previous deployment's cursor — which sits at the old deployment's head,
-- past the new one's start block. The indexer then resumes *ahead* of the new
-- contracts' history and never backfills it: it polls, finds nothing, and
-- reports healthy while the tables stay empty.
--
-- Storing the address set turns that into a startup failure. Empty means a
-- cursor written before this column existed; the indexer adopts the current
-- set in that case rather than refusing to start, since a pre-existing
-- deployment has no fingerprint to disagree with.
ALTER TABLE indexer_cursor ADD COLUMN contracts TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE indexer_cursor DROP COLUMN contracts;
