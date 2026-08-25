package ledger_test

import (
	"testing"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

func TestFingerprintIgnoresOrderAndCase(t *testing.T) {
	// The configured order and casing are not properties of the deployment.
	// If they changed the fingerprint, reordering two environment variables
	// would read as a contract redeployment and refuse to boot.
	a := ledger.Fingerprint([]string{
		"0x4697Ce4C2436750B89543405527C10bFABa8f8d0",
		"0xd5655Ac906E54b2fE5175126aee0C96dbB5f1DC4",
	})
	b := ledger.Fingerprint([]string{
		"0xd5655ac906e54b2fe5175126aee0c96dbb5f1dc4",
		"0x4697ce4c2436750b89543405527c10bfaba8f8d0",
	})
	if a != b {
		t.Fatalf("fingerprint changed with order/case: %s != %s", a, b)
	}
}

func TestFingerprintChangesWithAddresses(t *testing.T) {
	base := []string{"0xaaa", "0xbbb"}

	// A different contract at one slot is a different deployment.
	if got, want := ledger.Fingerprint([]string{"0xaaa", "0xccc"}), ledger.Fingerprint(base); got == want {
		t.Fatal("fingerprint did not change when an address changed")
	}
	// So is watching an additional contract — this is the case that bit us:
	// GHO-17 added the market to a stream that already had a cursor.
	if got, want := ledger.Fingerprint([]string{"0xaaa", "0xbbb", "0xccc"}), ledger.Fingerprint(base); got == want {
		t.Fatal("fingerprint did not change when a contract was added")
	}
}

func TestFingerprintIgnoresBlanks(t *testing.T) {
	// An unset optional address must not read as a different deployment from
	// one that was never configured at all.
	if got, want := ledger.Fingerprint([]string{"0xaaa", "", "  "}), ledger.Fingerprint([]string{"0xaaa"}); got != want {
		t.Fatalf("blank addresses changed the fingerprint: %s != %s", got, want)
	}
}
