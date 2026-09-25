package mirror

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The honesty of the mirror rests on one string appearing in three places:
// the constructor in `DemoPriceFeed.sol` writes it, `useMarketFeeds.ts`
// matches it to show the badge, and `verifyPair` here refuses any destination
// without it. Three hand-written copies, in three languages, none of which the
// compiler relates to the others — the same shape as the ABI drift that took
// the keeper down in GHO-93.
//
// So it is read from the other two rather than trusted.

func repoFile(t *testing.T, rel string) (string, bool) {
	t.Helper()
	path := filepath.Join("..", "..", "..", rel)
	b, err := os.ReadFile(path)
	if err != nil {
		// Checked out without its siblings, or running from somewhere else.
		// Skipped rather than failed: this asserts a relationship between
		// repositories, and its absence is not a defect in this one.
		t.Skipf("%s not readable from here (%v)", rel, err)
		return "", false
	}
	return string(b), true
}

func TestTheContractStillWritesTheMarkerTheMirrorDemands(t *testing.T) {
	src, ok := repoFile(t, "ghoststake-contracts/src/demo/DemoPriceFeed.sol")
	if !ok {
		return
	}
	if !strings.Contains(src, demoMarker) {
		t.Fatalf("DemoPriceFeed.sol no longer contains %q, so every destination "+
			"this mirror is pointed at would now be refused at startup", demoMarker)
	}
}

func TestTheAppStillBadgesTheMarkerTheMirrorDemands(t *testing.T) {
	src, ok := repoFile(t, "ghoststake-frontend/src/hooks/useMarketFeeds.ts")
	if !ok {
		return
	}
	if !strings.Contains(src, demoMarker) {
		t.Fatalf("useMarketFeeds.ts no longer matches %q. The mirror would keep "+
			"publishing and the app would stop marking the price as operator-set — "+
			"a price we sign, presented as one Chainlink secured", demoMarker)
	}
}
