package mirror

import (
	"context"
	"math/big"
	"os"
	"testing"
	"time"

	"forge.wavedidwhat.com/wave/ghoststake/internal/abis"
	"forge.wavedidwhat.com/wave/ghoststake/internal/chain"
)

// Reads the real Robinhood Chain mainnet equity feeds, which is the half of
// the mirror that needs no key and no funding.
//
//	MIRROR_LIVE_RPC_URL=https://rpc.mainnet.chain.robinhood.com go test ./internal/mirror/ -run Live -v
//
// Skipped without the variable, because CI has no business reaching mainnet.
func TestLiveSourceFeedsAreReadable(t *testing.T) {
	rpc := os.Getenv("MIRROR_LIVE_RPC_URL")
	if rpc == "" {
		t.Skip("set MIRROR_LIVE_RPC_URL to read the real feeds")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client, err := chain.Dial(ctx, rpc, 4663)
	if err != nil {
		t.Fatalf("dial Robinhood Chain mainnet: %v", err)
	}

	// The feeds a mirrored market would settle against, from
	// feeds-robinhood-mainnet.json.
	feeds := map[string]string{
		"RHTSLA / USD": "0x4A1166a659A55625345e9515b32adECea5547C38",
		"RHNVDA / USD": "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
		"RHAMZN / USD": "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C",
		"ETH / USD":    "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
	}

	for want, address := range feeds {
		t.Run(want, func(t *testing.T) {
			feed, err := client.Bind(abis.AggregatorV3Interface, address)
			if err != nil {
				t.Fatal(err)
			}

			description, err := readString(ctx, feed, "description")
			if err != nil {
				t.Fatalf("description(): %v", err)
			}

			decimals, err := readUint8(ctx, feed, "decimals")
			if err != nil {
				t.Fatalf("decimals(): %v", err)
			}
			// Every Chainlink USD feed is 8, and DemoPriceFeed is constructed
			// to match. A source that changed scale would be caught by
			// verifyPair at startup, but knowing which it is matters here.
			if decimals != 8 {
				t.Fatalf("%s publishes %d decimals, want 8", description, decimals)
			}

			reading, err := ReadLatest(ctx, feed)
			if err != nil {
				t.Fatalf("latestRoundData(): %v", err)
			}
			if reading.Answer.Sign() <= 0 {
				t.Fatalf("%s answered %s, which the mirror would refuse", description, reading.Answer)
			}
			if reading.UpdatedAt == 0 {
				t.Fatalf("%s has no publication time, so a mirror could not order its prints", description)
			}

			age := time.Since(time.Unix(int64(reading.UpdatedAt), 0))
			price := new(big.Float).Quo(new(big.Float).SetInt(reading.Answer), big.NewFloat(1e8))
			t.Logf("%-28s %10.2f  printed %v ago", description, price, age.Round(time.Minute))
		})
	}
}
