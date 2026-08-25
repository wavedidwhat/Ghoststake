package httpx

import (
	"errors"
	"log/slog"
	"net/http"
	"time"
)

// errNoChainReader is returned when an endpoint needs contract state and the
// process was started without a chain connection.
var errNoChainReader = errors.New("chain reader is not configured")

type healthResponse struct {
	Address string `json:"address"`
	ChainID int64  `json:"chainId"`
	// Block and AsOf are the block every figure below was read at, and its
	// timestamp. One block for all of them: a health factor is a ratio
	// between a collateral value and a debt, and reading those from different
	// blocks gives a number that was true at no point in the chain's history.
	Block uint64    `json:"block"`
	AsOf  time.Time `json:"asOf"`

	// The vault side.
	Principal    string `json:"principal"`
	SettledYield string `json:"settledYield"`
	AccruedYield string `json:"accruedYield"`
	// LedgerValue is principal plus all yield. NOT backed by assets — nothing
	// funds this yield — which is why Collateral, not this, is what may be
	// borrowed against.
	LedgerValue string `json:"ledgerValue"`
	SharesValue string `json:"sharesValue"`
	Collateral  string `json:"collateral"`

	// The debt side.
	//
	// Debt counts interest pending since the pool last accrued.
	// DebtAtStoredIndex is what the contract's own `balanceOfDebt` view
	// returns until someone pokes it, and PendingInterest is the gap. The
	// larger figure is the honest one: a liquidator's transaction accrues
	// before it reads the health factor, so this is the debt they would find.
	Debt              string `json:"debt"`
	DebtAtStoredIndex string `json:"debtAtStoredIndex"`
	PendingInterest   string `json:"pendingInterest"`
	ScaledDebt        string `json:"scaledDebt"`
	// BorrowIndex is the pool's stored index; AccruedBorrowIndex is that index
	// advanced to this block, which is what Debt is computed from.
	BorrowIndex        string `json:"borrowIndex"`
	AccruedBorrowIndex string `json:"accruedBorrowIndex"`

	MaxBorrowable string `json:"maxBorrowable"`

	// HealthFactor and LTV are WAD, and null when there is no debt: the
	// contract returns uint256 max for that case, which is correct on-chain
	// and a 78-digit integer in JSON.
	HealthFactor *string `json:"healthFactor"`
	LTV          *string `json:"ltv"`
	HasDebt      bool    `json:"hasDebt"`
	Liquidatable bool    `json:"liquidatable"`
	Band         string  `json:"band"`
}

// handleHealth returns one address's lending position: health factor,
// collateral, debt and accrued yield.
//
// Read from the chain rather than from the ledger. The ledger knows the
// scaled debt, and could tell you what was borrowed and when — but the debt
// owed right now is that scaled figure times an index that advances every
// second and emits nothing. There is no event to index for it. Reading the
// index live is the only way to be right, and once the call is being made
// anyway the rest of the position comes with it at the same block.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	address, ok := pathAddress(w, r)
	if !ok {
		return
	}
	if s.reader == nil {
		writeError(w, http.StatusServiceUnavailable, "chain reads are not configured")
		return
	}

	health, snapshot, err := s.reader.Health(r.Context(), address)
	if err != nil {
		serverError(w, "read health", err)
		return
	}

	writeJSON(w, http.StatusOK, healthResponse{
		Address: address,
		ChainID: s.cfg.ChainID,
		Block:   snapshot.Block,
		AsOf:    snapshot.Time,

		Principal:    health.Principal.String(),
		SettledYield: health.SettledYield.String(),
		AccruedYield: health.AccruedYield.String(),
		LedgerValue:  health.LedgerValue.String(),
		SharesValue:  health.SharesValue.String(),
		Collateral:   health.Collateral.String(),

		Debt:               health.Debt.String(),
		DebtAtStoredIndex:  health.DebtAtStoredIndex.String(),
		PendingInterest:    health.PendingInterest.String(),
		ScaledDebt:         health.ScaledDebt.String(),
		BorrowIndex:        health.BorrowIndex.String(),
		AccruedBorrowIndex: health.AccruedBorrowIndex.String(),

		MaxBorrowable: health.MaxBorrowable.String(),

		HealthFactor: decimalOrNil(health.HealthFactor),
		LTV:          decimalOrNil(health.LTV),
		HasDebt:      health.HasDebt,
		Liquidatable: health.Liquidatable,
		Band:         string(health.Band),
	})
}

// serverError logs the real cause and tells the client nothing about it.
//
// The detail goes to the log, not the response. An error string from a query
// or an RPC call names tables, addresses and internal hosts, and a read
// endpoint is exactly where someone probing would look for them.
func serverError(w http.ResponseWriter, what string, err error) {
	if errors.Is(err, errNoChainReader) {
		writeError(w, http.StatusServiceUnavailable, "chain reads are not configured")
		return
	}
	slog.Error(what, "err", err)
	writeError(w, http.StatusInternalServerError, "request failed")
}
