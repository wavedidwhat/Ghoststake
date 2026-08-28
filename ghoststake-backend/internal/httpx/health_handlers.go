package httpx

import (
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/wavedidwhat/ghoststake/internal/finance"
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

// How many borrowers one at-risk scan reads, by default and at most.
//
// Each one costs four `eth_call`s, so this is a bound on RPC work and not on
// rows. It is deliberately smaller than the round limits: those read a table,
// this reads a chain.
const (
	defaultAtRiskLimit = 50
	maxAtRiskLimit     = 200
)

type atRiskPosition struct {
	Address string `json:"address"`

	Collateral string `json:"collateral"`
	Debt       string `json:"debt"`
	// HealthFactor is WAD and never null here: an account with no debt is not
	// in this list at all.
	HealthFactor string `json:"healthFactor"`
	LTV          string `json:"ltv"`
	Band         string `json:"band"`
	Liquidatable bool   `json:"liquidatable"`

	// What calling `liquidate` right now would cost and pay.
	MaxRepay        string `json:"maxRepay"`
	Seized          string `json:"seized"`
	Bonus           string `json:"bonus"`
	Profitable      bool   `json:"profitable"`
	FullLiquidation bool   `json:"fullLiquidation"`

	// WriteOffCandidate is a position that owes more than it holds, where no
	// liquidation can come out ahead and `writeOffBadDebt` is the call that
	// closes it (GHO-45). Distinguished because sending a liquidator at one
	// is sending them to lose money.
	WriteOffCandidate bool `json:"writeOffCandidate"`
}

type atRiskResponse struct {
	ChainID int64  `json:"chainId"`
	Block   uint64 `json:"block"`
	// IndexedBlock is how far the ledger has read, and it bounds who could be
	// in this list at all: a borrower whose first draw is newer than this has
	// not been seen yet. Every *figure* is from `block`, which is the chain
	// head — the ledger supplies the names and the chain supplies the numbers.
	IndexedBlock uint64    `json:"indexedBlock"`
	AsOf         time.Time `json:"asOf"`

	// Scanned is how many borrowers were read; Truncated says the cap was
	// reached and there may be more. Reported rather than implied, because a
	// liquidator acting on a silently truncated list would believe they had
	// seen everything.
	Scanned   int  `json:"scanned"`
	Truncated bool `json:"truncated"`

	Positions []atRiskPosition `json:"positions"`
}

// handleAtRisk lists borrowers by how close they are to liquidation.
//
// The endpoint GHO-42 is about. `liquidate` is permissionless, which is what
// keeps the protocol solvent — but every view in the system was per-address,
// so a liquidator had to already know whose position was underwater before
// they could act. The incentive existed, the mechanism existed, and the
// discovery step did not. That is how a protocol accumulates bad debt while
// telling itself liquidation is permissionless.
//
// Two sources, each asked what only it can answer. The ledger supplies the
// *names*: it has held every Borrowed and Repaid since GHO-10, and the chain
// has no borrower enumeration at all. The chain supplies the *numbers*: a
// health factor is scaled debt times an index that advances every second and
// emits nothing, so there is no event to index for it.
//
// Ordered by health factor ascending — the sickest first, which is the order a
// liquidator reads in. Not by the ledger's exposure ordering, which decides
// only who gets scanned when the cap bites.
func (s *Server) handleAtRisk(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if s.reader == nil {
		writeError(w, http.StatusServiceUnavailable, "chain reads are not configured")
		return
	}
	limit := clampAtRiskLimit(r.URL.Query().Get("limit"))

	// One extra, so "there were more than the cap" is a fact rather than an
	// inference from the count coming back exactly full.
	borrowers, err := s.store.BorrowersByExposure(ctx, s.cfg.ChainID, s.deployment, limit+1)
	if err != nil {
		serverError(w, "list borrowers", err)
		return
	}
	truncated := len(borrowers) > limit
	if truncated {
		borrowers = borrowers[:limit]
	}

	healths, snap, err := s.reader.HealthBatch(ctx, borrowers)
	if err != nil {
		serverError(w, "read borrower health", err)
		return
	}
	params, err := s.reader.VaultParams(ctx)
	if err != nil {
		serverError(w, "read vault params", err)
		return
	}

	positions := make([]atRiskPosition, 0, len(healths))
	for i, health := range healths {
		// A borrower whose debt has since been repaid is still in the ledger
		// query — `SUM(delta) > 0` is scaled debt, and a full repay zeroes it,
		// but a rounding residue need not. Dropped here against the chain,
		// which is the authority.
		if !health.HasDebt {
			continue
		}
		quote := finance.LiquidationQuote(health.Collateral, health.Debt, health.HealthFactor, params)

		positions = append(positions, atRiskPosition{
			Address:      borrowers[i],
			Collateral:   health.Collateral.String(),
			Debt:         health.Debt.String(),
			HealthFactor: health.HealthFactor.String(),
			LTV:          health.LTV.String(),
			Band:         string(health.Band),
			Liquidatable: health.Liquidatable,

			MaxRepay:        quote.MaxRepay.String(),
			Seized:          quote.Seized.String(),
			Bonus:           quote.Bonus.String(),
			Profitable:      quote.Profitable,
			FullLiquidation: quote.FullLiquidation,

			// The GHO-45 case, stated from the same comparison the contract
			// makes: a position owing more than it holds cannot be closed by
			// any liquidation, profitable or otherwise.
			WriteOffCandidate: health.Debt.Cmp(health.SharesValue) > 0,
		})
	}

	sort.Slice(positions, func(i, j int) bool {
		a, _ := new(big.Int).SetString(positions[i].HealthFactor, 10)
		b, _ := new(big.Int).SetString(positions[j].HealthFactor, 10)
		if a == nil || b == nil {
			return false
		}
		return a.Cmp(b) < 0
	})

	writeJSON(w, http.StatusOK, atRiskResponse{
		ChainID:      s.cfg.ChainID,
		Block:        snap.Block,
		IndexedBlock: s.indexedBlock(ctx),
		AsOf:         snap.Time,
		Scanned:      len(borrowers),
		Truncated:    truncated,
		Positions:    positions,
	})
}

func clampAtRiskLimit(raw string) int {
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return defaultAtRiskLimit
	}
	if n > maxAtRiskLimit {
		return maxAtRiskLimit
	}
	return n
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
