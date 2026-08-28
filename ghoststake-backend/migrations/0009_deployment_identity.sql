-- +goose Up

-- GHO-51: let a row say which deployment it came from.
--
-- `contract` holds a contract's *name* — 'CollateralVault' — which was enough
-- while there was only ever one of each. It stops being enough the moment the
-- contracts are redeployed: two vaults both write 'CollateralVault', and every
-- balance in the ledger is summed by (chain_id, account, ledger) with no third
-- term. An old vault's shares would be added to a new vault's shares, and an
-- old pool's debt to a new pool's debt. One number, no error, wrong.
--
-- That is the same failure GHO-43 found one layer down, where `round_events`
-- keyed by (chain_id, round_id) merged two markets' round 7 into a single
-- round whose pools were the sum of two unrelated bets. The fix there was to
-- make identity the real thing — the (market, id) pair — rather than a label.
-- This is that move at the deployment level.
--
-- The address, not a synthesised deployment id. It is on the log already, it
-- cannot disagree with the row it describes, and a deployment is then a set of
-- addresses rather than a name somebody has to keep in sync. `round_events`
-- needs nothing: its `market` column is already an address, so a redeployed
-- market is already a different market there.
ALTER TABLE ledger_entries ADD COLUMN contract_address TEXT;

-- Nullable, and deliberately not backfilled here. SQL cannot know which
-- addresses this deployment watches — that lives in the process's
-- configuration — so the repair happens at preflight where the configured set
-- is in scope and the answer can be checked rather than assumed. Exactly the
-- argument behind GHO-43's `attributeExistingRounds`.

-- Balance derivation now filters by the deployment's addresses, so the index
-- has to lead with the column that narrows first and still support the
-- account lookup. The GHO-42 book index stays: "who has any debt" is a
-- different question from "what does this account hold".
CREATE INDEX ledger_entries_deployment_idx
    ON ledger_entries (chain_id, contract_address, account, ledger)
    WHERE kind = 'balance';

-- One cursor per deployment, not per chain.
--
-- `StreamName` was 'ghoststake:<chain>', and that is precisely why a
-- redeployment inherits the previous deployment's position: the stream is
-- chain-scoped, the cursor is at the old contracts' head, and the new
-- deployment's history is below it. GHO-17 caught that with a fingerprint
-- check that refuses to boot; putting the fingerprint in the stream name means
-- there is nothing to collide in the first place, and the old cursor survives
-- beside the new one instead of being deleted.
--
-- Existing cursors are left under their old name on purpose. The indexer
-- adopts one at preflight once it knows its own fingerprint — renaming here
-- would need the fingerprint, and SQL does not have it.

-- +goose Down
DROP INDEX ledger_entries_deployment_idx;
ALTER TABLE ledger_entries DROP COLUMN contract_address;
