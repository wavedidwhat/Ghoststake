-- +goose Up

-- GHO-42: find every borrower, not just look one up.
--
-- `liquidate` is permissionless, which is what keeps the protocol solvent —
-- but nothing anywhere enumerated the people who could be liquidated. Every
-- view was per-address, so a liquidator had to already know whose position was
-- underwater before they could act on it. The incentive and the mechanism both
-- existed; the discovery step did not.
--
-- The set of borrowers is one query away in `ledger_entries`, which has held
-- every Borrowed and Repaid since GHO-10. It just needs an index that leads
-- with the book rather than with the account.
--
-- `ledger_entries_balance_idx` is (chain_id, account, ledger) — right for
-- "what is this account's debt", wrong for "who has any debt", which has to
-- scan every account under the existing ordering. This is the same partial
-- index with the two trailing columns swapped, so the planner can walk one
-- book directly.
CREATE INDEX ledger_entries_book_idx
    ON ledger_entries (chain_id, ledger, account)
    WHERE kind = 'balance';
