-- +goose Up

-- GHO-81: keep a market's immutables, because they are immutable.
--
-- `entryCutoff`, `rake` and `minSidePool` are set in ParimutuelRound's
-- constructor and there is no function that changes any of them. The Reader
-- has always cached them, but only in a map on the process, and only on
-- success — so the cache empties on every deploy and refills by asking an RPC
-- endpoint three questions whose answers cannot have changed.
--
-- That was free until it wasn't. On 2026-09-19 Infura rate-limited the key and
-- every read that touched the chain 500'd: /rounds, /health and /positions for
-- anyone who actually held one. None of those reads needed the chain for
-- anything else — the rounds come out of this database — they needed three
-- constants, and the only copy of them lived in a process that had just
-- restarted. Runbook Part 7.71.
--
-- Persisting them puts the RPC out of the steady-state read path entirely. A
-- market is read from the chain once, ever, and after that from here.
CREATE TABLE market_params (
    chain_id      BIGINT       NOT NULL,
    -- Checksummed, which is the spelling the indexer stamps onto every round
    -- event. A market read out of round_events finds its parameters without
    -- anyone normalising at the call site.
    market        TEXT         NOT NULL,

    -- Seconds before lock that entry stops. Comfortably an int64; stored as
    -- BIGINT rather than NUMERIC because unlike the two below it is not a
    -- uint256 and pretending otherwise would invite a big.Int at the call
    -- site for a number that is always small.
    entry_cutoff  BIGINT       NOT NULL,

    -- WAD-scaled and a full uint256. NUMERIC(78, 0) is the convention here
    -- (see round_events.amount): a wei-scale value exceeds every fixed-width
    -- integer type Postgres has, and the driver round-trips it as a string.
    rake          NUMERIC(78,0) NOT NULL,
    min_side_pool NUMERIC(78,0) NOT NULL,

    -- When the chain was asked. Not used to expire anything — these values
    -- cannot change — but a row with no provenance is a row nobody will dare
    -- delete later, and this says which deployment's read it came from.
    read_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- The pair, never the address alone. GHO-51 made round history span
    -- deployments on purpose, so the same market address can legitimately
    -- appear under more than one chain, and GHO-43 is the standing lesson
    -- about what happens when identity is a label rather than the real thing.
    PRIMARY KEY (chain_id, market)
);

-- +goose Down
DROP TABLE market_params;
