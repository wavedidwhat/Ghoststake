-- +goose Up

-- Which decoder wrote the rows a cursor's position was reached by (GHO-49).
--
-- The sibling of `contracts`, and it exists for a symmetric failure.
-- `contracts` catches the indexer watching a *different address set* than the
-- one its position was built from. This catches it watching the same
-- addresses with a *different decoder* — one that now derives records the
-- earlier one threw away.
--
-- That is not hypothetical: GHO-49 found that the pool's `Supplied(user,
-- amount, scaledAmount)` had only ever had its scaled half recorded. The
-- nominal amount — the number the lender actually handed over, and the only
-- one a history page can honestly show — was decoded and discarded. Adding it
-- fixes every supply from that deploy onward and does nothing at all for the
-- ones already indexed, because nothing re-reads a block the cursor has
-- passed.
--
-- So the version is stamped beside the position. When it disagrees, the
-- indexer replays its range once; the stamp is written by the same
-- transaction that advances the cursor, so the replay happens exactly once per
-- decoder change and cannot loop.
--
-- Empty means "written before this column existed", the same convention
-- `contracts` and `round_events.market` use.
ALTER TABLE indexer_cursor ADD COLUMN decoders TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE indexer_cursor DROP COLUMN decoders;
