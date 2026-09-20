package store

import (
	"context"
	"errors"
	"fmt"
	"math/big"

	"github.com/jackc/pgx/v5"

	"forge.wavedidwhat.com/wave/ghoststake/internal/protocol"
)

// MarketParams returns a market's stored immutables.
//
// The bool is "we have them", not "the query worked" — a market nobody has
// read from the chain yet is an ordinary state on a first boot, not a failure,
// and the caller's next move (ask the chain) is the same either way.
func (s *Store) MarketParams(ctx context.Context, chainID int64, market string) (protocol.MarketParams, bool, error) {
	var (
		entryCutoff int64
		rake        string
		minSidePool string
	)
	err := s.pool.QueryRow(ctx,
		`SELECT entry_cutoff, rake, min_side_pool
		   FROM market_params
		  WHERE chain_id = $1 AND market = $2`,
		chainID, market,
	).Scan(&entryCutoff, &rake, &minSidePool)

	if errors.Is(err, pgx.ErrNoRows) {
		return protocol.MarketParams{}, false, nil
	}
	if err != nil {
		return protocol.MarketParams{}, false, fmt.Errorf("read market params: %w", err)
	}

	// Parsed, not asserted. NUMERIC comes back as a string and a malformed one
	// would otherwise become a nil *big.Int that panics on first use, several
	// layers from here.
	r, ok := new(big.Int).SetString(rake, 10)
	if !ok {
		return protocol.MarketParams{}, false, fmt.Errorf("market params %s: rake %q is not an integer", market, rake)
	}
	m, ok := new(big.Int).SetString(minSidePool, 10)
	if !ok {
		return protocol.MarketParams{}, false, fmt.Errorf("market params %s: min_side_pool %q is not an integer", market, minSidePool)
	}

	return protocol.MarketParams{EntryCutoff: entryCutoff, Rake: r, MinSidePool: m}, true, nil
}

// PutMarketParams records what the chain said.
//
// Idempotent and deliberately not an upsert that overwrites: these values are
// immutable, so a second write for the same market is either the same answer
// or a bug, and silently taking the newer one would hide the bug. DO NOTHING
// keeps the first read, which is the one that was verified against a contract
// this process bound itself.
func (s *Store) PutMarketParams(ctx context.Context, chainID int64, market string, p protocol.MarketParams) error {
	if p.Rake == nil || p.MinSidePool == nil {
		return fmt.Errorf("market params %s: rake and min_side_pool are required", market)
	}
	_, err := s.pool.Exec(ctx,
		`INSERT INTO market_params (chain_id, market, entry_cutoff, rake, min_side_pool)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (chain_id, market) DO NOTHING`,
		chainID, market, p.EntryCutoff, p.Rake.String(), p.MinSidePool.String(),
	)
	if err != nil {
		return fmt.Errorf("write market params: %w", err)
	}
	return nil
}
