package live_test

import (
	"math/big"
	"testing"
	"time"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
	"github.com/wavedidwhat/ghoststake/internal/live"
)

const alice = "0x000000000000000000000000000000000000a11c"

func batch(roundID uint64, account string) ledger.Batch {
	return ledger.Batch{
		Rounds: []ledger.RoundEvent{{
			Provenance: ledger.Provenance{ChainID: 31337, BlockNumber: 42, EventName: ledger.PositionTaken},
			RoundID:    roundID,
			Account:    account,
			Amount:     big.NewInt(100),
			Data:       map[string]string{},
		}},
	}
}

func cursor(block uint64) ledger.Cursor {
	return ledger.Cursor{Stream: "ghoststake:31337", ChainID: 31337, LastBlock: block}
}

func recv(t *testing.T, ch <-chan live.Update) live.Update {
	t.Helper()
	select {
	case update := <-ch:
		return update
	case <-time.After(2 * time.Second):
		t.Fatal("no update delivered")
		return live.Update{}
	}
}

func TestEverySubscriberGetsTheUpdate(t *testing.T) {
	broker := live.NewBroker()

	first, closeFirst := broker.Subscribe(4)
	defer closeFirst()
	second, closeSecond := broker.Subscribe(4)
	defer closeSecond()

	broker.Publish(batch(7, alice), cursor(42))

	for i, ch := range []<-chan live.Update{first, second} {
		update := recv(t, ch)
		if !update.Touched(7) {
			t.Fatalf("subscriber %d: round 7 not named: %+v", i, update)
		}
		if !update.TouchedAccount(alice) {
			t.Fatalf("subscriber %d: account not named: %+v", i, update)
		}
		if update.Block != 42 || update.ChainID != 31337 {
			t.Fatalf("subscriber %d: cursor not carried: %+v", i, update)
		}
	}
}

// The whole reason updates carry no data: a subscriber that has fallen behind
// is skipped rather than allowed to block the indexer's write loop. A browser
// tab that stopped reading must not be able to stop the chain being indexed.
func TestASlowSubscriberIsDroppedRatherThanBlocking(t *testing.T) {
	broker := live.NewBroker()
	ch, stop := broker.Subscribe(1)
	defer stop()

	// One fills the buffer; the rest have nowhere to go.
	for i := range 5 {
		broker.Publish(batch(uint64(i), alice), cursor(uint64(40+i)))
	}

	if broker.Dropped() == 0 {
		t.Fatal("nothing was dropped, so a full buffer must have blocked")
	}
	// And the one it did take is still there to read: dropping the newer ones
	// must not corrupt the queue.
	if update := recv(t, ch); update.Block == 0 {
		t.Fatalf("buffered update is empty: %+v", update)
	}
}

// Unsubscribing must close the channel and stop delivery, or a disconnected
// websocket leaks a channel the broker writes to forever.
func TestUnsubscribeClosesTheChannel(t *testing.T) {
	broker := live.NewBroker()
	ch, stop := broker.Subscribe(4)

	stop()
	if broker.Subscribers() != 0 {
		t.Fatalf("%d subscribers after unsubscribing", broker.Subscribers())
	}

	if _, open := <-ch; open {
		t.Fatal("channel still open after unsubscribing")
	}
	// Idempotent: a deferred stop after an explicit one must not panic on a
	// double close, which is exactly the shape the websocket handler has.
	stop()

	// And publishing afterwards must not panic on the closed channel.
	broker.Publish(batch(7, alice), cursor(50))
}

// An empty range must not wake anybody. The indexer polls every few seconds
// and almost every cycle finds nothing.
func TestAnEmptyBatchPublishesNothing(t *testing.T) {
	broker := live.NewBroker()
	ch, stop := broker.Subscribe(1)
	defer stop()

	broker.Publish(ledger.Batch{}, cursor(42))

	select {
	case update := <-ch:
		t.Fatalf("an empty batch woke a subscriber: %+v", update)
	case <-time.After(50 * time.Millisecond):
	}
}

// Lending entries carry no round, but they still name the account: a borrow
// or a liquidation changes what a watching health panel should say.
func TestLendingEntriesNameTheirAccounts(t *testing.T) {
	broker := live.NewBroker()
	ch, stop := broker.Subscribe(2)
	defer stop()

	broker.Publish(ledger.Batch{Entries: []ledger.Entry{{
		Provenance:   ledger.Provenance{ChainID: 31337, BlockNumber: 42, EventName: "Borrowed"},
		Kind:         ledger.KindBalance,
		Account:      alice,
		Ledger:       ledger.DebtScaled,
		Delta:        big.NewInt(500),
		Counterparty: "0x000000000000000000000000000000000000B0B0",
	}}}, cursor(42))

	update := recv(t, ch)
	if len(update.RoundIDs) != 0 {
		t.Fatalf("a lending entry named a round: %+v", update)
	}
	if !update.TouchedAccount(alice) {
		t.Fatalf("the borrower was not named: %+v", update)
	}
	if !update.TouchedAccount("0x000000000000000000000000000000000000B0B0") {
		t.Fatalf("the counterparty was not named: %+v", update)
	}
}

// One round touched twice in a range is named once.
func TestAccountsAndRoundsAreDeduplicated(t *testing.T) {
	broker := live.NewBroker()
	ch, stop := broker.Subscribe(2)
	defer stop()

	twice := batch(7, alice)
	twice.Rounds = append(twice.Rounds, twice.Rounds[0])
	broker.Publish(twice, cursor(42))

	update := recv(t, ch)
	if len(update.RoundIDs) != 1 || len(update.Accounts) != 1 {
		t.Fatalf("not deduplicated: %+v", update)
	}
}
