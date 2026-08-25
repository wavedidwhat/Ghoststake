package finance

import "math/big"

// VaultParams are the vault's immutable risk parameters, all WAD.
type VaultParams struct {
	MaxLTV               *big.Int
	LiquidationThreshold *big.Int
}

// VaultState is the raw state of one user's vault position, as the chain
// holds it. Every figure below is derived from these — nothing else is read.
type VaultState struct {
	// Principal is the deposit basis. It earns yield and never absorbs it.
	Principal *big.Int
	// SettledYield is yield banked at past checkpoints. It does not itself
	// earn — the vault pays simple interest, not compound.
	SettledYield *big.Int
	// RatePerSecond is the WAD yield rate in force for this position.
	RatePerSecond *big.Int
	// StartTime is the last accrual checkpoint, as a unix second.
	StartTime int64

	// SharesValue is what the user's shares are actually worth in assets
	// (`convertToAssets(balanceOf(user))`). The cap on collateral.
	SharesValue *big.Int

	// ScaledDebt is the pool's index-invariant debt figure, and BorrowIndex
	// is the pool's *stored* RAY index. Their product is StoredDebt.
	ScaledDebt  *big.Int
	BorrowIndex *big.Int

	// BorrowRatePerSecond and LastAccrualTime are what the stored index is
	// missing: interest since the last time anyone poked the pool. See
	// AccruedBorrowIndex for why reading the stored index alone understates a
	// debt, and overstates the health of the position behind it.
	BorrowRatePerSecond *big.Int
	LastAccrualTime     int64
}

// AccruedYield is yield earned since the last checkpoint.
//
//	CollateralVault.accruedYield:
//	  mulDiv(principal, rate * elapsed, WAD)
//
// The division stays last, exactly as in the contract. Folding it in earlier —
// yield-per-second first, then scaling by elapsed — truncates to zero for
// small principals and destroys their accrual entirely.
//
// Simple interest, not compound: yield is a pure function of principal x time,
// so it cannot be increased by settling more often. That is deliberate in the
// contract — `settle()` is free and permissionless, and compounding would make
// the total a function of how often anyone chose to call it.
func AccruedYield(s VaultState, nowUnix int64) *big.Int {
	elapsed := nowUnix - s.StartTime
	if elapsed <= 0 || s.Principal == nil || s.Principal.Sign() == 0 {
		return new(big.Int)
	}
	rate := new(big.Int).Mul(or0(s.RatePerSecond), big.NewInt(elapsed))
	return MulDiv(s.Principal, rate, WAD)
}

// TotalLedgerValue is everything the vault's books say the user is owed.
//
// NOT backed by real assets. Nothing funds this yield: no rewards ever flow
// into the vault, so the settled and accrued parts are a claim on assets that
// do not exist. Never lend against this — lend against CollateralValue.
func TotalLedgerValue(s VaultState, nowUnix int64) *big.Int {
	total := new(big.Int).Add(or0(s.Principal), or0(s.SettledYield))
	return total.Add(total, AccruedYield(s, nowUnix))
}

// CollateralValue is ledger value capped at what the vault could actually pay
// out for the user's shares.
//
//	CollateralVault.collateralValue:
//	  min(totalLedgerValue(user), convertToAssets(balanceOf(user)))
//
// The cap is the whole safety property. Unfunded yield above it is not
// collateral, and lending against it would be lending against nothing.
func CollateralValue(s VaultState, nowUnix int64) *big.Int {
	return Min(TotalLedgerValue(s, nowUnix), s.SharesValue)
}

// StoredDebt is what the pool's own view reports right now.
//
//	BorrowLiquidityPool.balanceOfDebt:
//	  mulDiv(scaledDebt, borrowIndex, RAY)
//
// Why a scaled amount and an index, rather than a running total: interest
// accrues per second and emits no event. Nominal borrow and repay amounts sum
// to principal movements and lose every second of accrual between them. The
// scaled amount is invariant under accrual, so it does sum.
//
// This figure is behind by however long it has been since anyone last poked
// the pool. Report Debt instead; this exists to be compared against the
// contract's view, and to show how far behind that view has fallen.
func StoredDebt(s VaultState) *big.Int {
	return MulDiv(s.ScaledDebt, s.BorrowIndex, RAY)
}

// AccruedBorrowIndex advances the stored index to `nowUnix`.
//
//	BorrowLiquidityPool.accrue:
//	  elapsed      = now - lastAccrualTime
//	  borrowGrowth = borrowRatePerSecond * elapsed
//	  borrowIndex += mulDiv(borrowIndex, borrowGrowth, WAD)
//
// # Why this is not optional
//
// `accrue()` is permissionless and every mutating entry point calls it first,
// so the index is current whenever anything actually happens. The *views* are
// not: `balanceOfDebt` and `healthFactor` read the stored index, and between
// accruals they report a debt that is too small and a position that is too
// healthy.
//
// That gap is not academic. `CollateralVault.liquidate` calls
// `lienSource.accrue()` before it reads the health factor — so the number that
// decides a liquidation is this one, not the view's. An API serving the view
// would tell someone they are safe at 1.02 while a liquidator, whose
// transaction accrues first, finds them at 0.99 and takes their collateral at
// a bonus.
//
// So this is what the API reports, with the contract's view beside it as the
// smaller figure it is.
func AccruedBorrowIndex(s VaultState, nowUnix int64) *big.Int {
	index := new(big.Int).Set(or0(s.BorrowIndex))
	elapsed := nowUnix - s.LastAccrualTime
	if elapsed <= 0 || index.Sign() == 0 {
		return index
	}
	growth := new(big.Int).Mul(or0(s.BorrowRatePerSecond), big.NewInt(elapsed))
	if growth.Sign() == 0 {
		return index
	}
	return index.Add(index, MulDiv(index, growth, WAD))
}

// Debt is what the user owes once pending interest is counted: the debt a
// liquidator would find, because their transaction accrues first.
func Debt(s VaultState, nowUnix int64) *big.Int {
	return MulDiv(s.ScaledDebt, AccruedBorrowIndex(s, nowUnix), RAY)
}

// HealthFactor is how far a position is from liquidation, WAD-scaled.
//
//	CollateralVault.healthFactor:
//	  collateralValue * liquidationThreshold / lien
//
// 1e18 is exactly on the line: above it the position is safe, below it anyone
// may liquidate part of it for a bonus.
//
// A position with no debt returns ok=false rather than an enormous number.
// The contract returns `type(uint256).max`, which is correct on-chain and
// useless off it — serialised into JSON it is a 78-digit integer that every
// consumer has to special-case anyway. Saying "there is no ratio" once, here,
// is better than every caller inferring it from a magic value.
func HealthFactor(collateralValue, liquidationThreshold, debt *big.Int) (*big.Int, bool) {
	if debt == nil || debt.Sign() == 0 {
		return nil, false
	}
	return MulDiv(collateralValue, liquidationThreshold, debt), true
}

// Liquidatable is the contract's own test: strictly below the line.
//
// Note the asymmetry with Band below — this is the fact, the band is a
// warning. A position at exactly 1.0 is not liquidatable.
func Liquidatable(healthFactor *big.Int, hasDebt bool) bool {
	return hasDebt && healthFactor != nil && healthFactor.Cmp(WAD) < 0
}

// MaxBorrowable is how much more the position may draw.
//
//	CollateralVault.maxBorrowable:
//	  ceiling = collateralValue * maxLTV / WAD
//	  return ceiling > lien ? ceiling - lien : 0
//
// Note this uses maxLTV, not the liquidation threshold: the borrow ceiling is
// deliberately below the line at which the position becomes liquidatable, so
// a borrower at their limit is not one block of interest away from being
// liquidated.
func MaxBorrowable(collateralValue, maxLTV, debt *big.Int) *big.Int {
	ceiling := MulDiv(collateralValue, maxLTV, WAD)
	if ceiling.Cmp(or0(debt)) <= 0 {
		return new(big.Int)
	}
	return ceiling.Sub(ceiling, or0(debt))
}

// LTV is debt as a fraction of collateral, WAD. Zero collateral with no debt
// is 0; zero collateral with debt is reported as ok=false, because the ratio
// is undefined rather than infinite.
func LTV(debt, collateralValue *big.Int) (*big.Int, bool) {
	if collateralValue == nil || collateralValue.Sign() == 0 {
		return nil, or0(debt).Sign() == 0
	}
	return MulDiv(debt, WAD, collateralValue), true
}

// Band classifies a health factor for display.
type Band string

const (
	// BandNone is a position with no debt: it cannot be liquidated.
	BandNone Band = "none"
	// BandSafe is comfortably clear of the line.
	BandSafe Band = "safe"
	// BandCaution is within 1.5x.
	BandCaution Band = "caution"
	// BandDanger is within 1.2x — close enough that a few hours of interest
	// or a share-price move could cross it.
	BandDanger Band = "danger"
)

// Band thresholds, WAD. Deliberately above the contract's 1.0 line: a warning
// that arrives at the moment of liquidation is not a warning. These mirror the
// frontend's `healthBand`, which still computes its own for the pages that
// read the contract directly.
var (
	bandCautionAt = MulDiv(WAD, big.NewInt(15), big.NewInt(10)) // 1.5
	bandDangerAt  = MulDiv(WAD, big.NewInt(12), big.NewInt(10)) // 1.2
)

// BandOf reads a health factor into a band. A liquidatable position is
// BandDanger — the API reports `liquidatable` separately as the fact, because
// that is the contract's answer and this is only a reading of the ratio.
func BandOf(healthFactor *big.Int, hasDebt bool) Band {
	if !hasDebt || healthFactor == nil {
		return BandNone
	}
	switch {
	case healthFactor.Cmp(bandDangerAt) < 0:
		return BandDanger
	case healthFactor.Cmp(bandCautionAt) < 0:
		return BandCaution
	default:
		return BandSafe
	}
}

// Health is the whole picture of one position, derived in one pass.
//
// Derived together on purpose: every figure comes from a single VaultState,
// so they describe one instant. Fetching them one call at a time would let a
// health factor from one block sit beside a debt from the next, and the
// arithmetic between them would be a number that was never true.
type Health struct {
	Principal    *big.Int
	SettledYield *big.Int
	AccruedYield *big.Int
	LedgerValue  *big.Int
	SharesValue  *big.Int
	Collateral   *big.Int

	// Debt counts interest pending since the last accrual. DebtAtStoredIndex
	// is what the contract's own view says until someone pokes the pool, and
	// PendingInterest is the difference between them.
	Debt               *big.Int
	DebtAtStoredIndex  *big.Int
	PendingInterest    *big.Int
	ScaledDebt         *big.Int
	BorrowIndex        *big.Int
	AccruedBorrowIndex *big.Int
	MaxBorrowable      *big.Int

	HealthFactor *big.Int
	LTV          *big.Int
	HasDebt      bool
	Liquidatable bool
	Band         Band
}

// Describe derives every figure in Health from one snapshot of raw state.
func Describe(s VaultState, p VaultParams, nowUnix int64) Health {
	collateral := CollateralValue(s, nowUnix)
	debt := Debt(s, nowUnix)
	stored := StoredDebt(s)
	hf, hasDebt := HealthFactor(collateral, p.LiquidationThreshold, debt)
	ltv, _ := LTV(debt, collateral)

	return Health{
		Principal:          or0(s.Principal),
		SettledYield:       or0(s.SettledYield),
		AccruedYield:       AccruedYield(s, nowUnix),
		LedgerValue:        TotalLedgerValue(s, nowUnix),
		SharesValue:        or0(s.SharesValue),
		Collateral:         collateral,
		Debt:               debt,
		DebtAtStoredIndex:  stored,
		PendingInterest:    new(big.Int).Sub(debt, stored),
		ScaledDebt:         or0(s.ScaledDebt),
		BorrowIndex:        or0(s.BorrowIndex),
		AccruedBorrowIndex: AccruedBorrowIndex(s, nowUnix),
		MaxBorrowable:      MaxBorrowable(collateral, p.MaxLTV, debt),
		HealthFactor:       hf,
		LTV:                ltv,
		HasDebt:            hasDebt,
		Liquidatable:       Liquidatable(hf, hasDebt),
		Band:               BandOf(hf, hasDebt),
	}
}
