// Package live carries "something changed" from the indexer to whoever is
// watching over a websocket.
//
// It carries notifications, not data. An update says which rounds and which
// accounts moved and at what height; the subscriber then re-reads the current
// state for itself. That indirection is what makes the whole thing safe to
// drop messages from — see Broker.Publish.
package live

import (
	"sync"

	"github.com/wavedidwhat/ghoststake/internal/ledger"
)

// Update is one committed indexing range, summarised.
type Update struct {
	ChainID int64
	// Block is the height the range ended at.
	Block uint64
	// RoundIDs are the rounds something happened to, newest last.
	RoundIDs []uint64
	// Accounts are the addresses named by any record in the range, in the
	// checksummed form the ledger stores.
	Accounts []string
}

// Touched reports whether an update concerns a round a subscriber cares about.
func (u Update) Touched(roundID uint64) bool {
	for _, id := range u.RoundIDs {
		if id == roundID {
			return true
		}
	}
	return false
}

// TouchedAccount reports whether an update names an account.
func (u Update) TouchedAccount(account string) bool {
	for _, a := range u.Accounts {
		if a == account {
			return true
		}
	}
	return false
}

// Broker fans one publisher out to many subscribers.
type Broker struct {
	mu   sync.Mutex
	next int
	subs map[int]chan Update

	// dropped counts updates a subscriber was too slow to take. Exposed for
	// the readiness detail rather than kept as a private curiosity: a
	// non-zero and climbing count is the signal that the fan-out is the
	// bottleneck, and there is no other way to see it.
	dropped uint64
}

func NewBroker() *Broker { return &Broker{subs: map[int]chan Update{}} }

// Subscribe returns a channel of updates and the function that closes it.
//
// The buffer is small on purpose. A subscriber that has fallen behind does not
// need the updates it missed: each one only says "re-read", and the next one
// says it again. Queueing them would grow memory to deliver notifications
// whose content is already stale.
func (b *Broker) Subscribe(buffer int) (<-chan Update, func()) {
	if buffer < 1 {
		buffer = 1
	}
	ch := make(chan Update, buffer)

	b.mu.Lock()
	id := b.next
	b.next++
	b.subs[id] = ch
	b.mu.Unlock()

	var once sync.Once
	return ch, func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.subs, id)
			b.mu.Unlock()
			close(ch)
		})
	}
}

// Publish notifies every subscriber, never blocking on any of them.
//
// A full channel means that subscriber has not drained the last notification
// yet, and the update is dropped for them. This is safe precisely because an
// update carries no data: the subscriber's pending read will see the newer
// state anyway. Blocking instead would let one stalled websocket connection
// hold up the indexer's write loop, which is the failure that actually
// matters — a slow browser tab must not be able to stop the chain being read.
func (b *Broker) Publish(batch ledger.Batch, cursor ledger.Cursor) {
	update := summarise(batch, cursor)
	if len(update.RoundIDs) == 0 && len(update.Accounts) == 0 {
		return
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	for _, ch := range b.subs {
		select {
		case ch <- update:
		default:
			b.dropped++
		}
	}
}

// Dropped is how many notifications have been discarded for slow subscribers.
func (b *Broker) Dropped() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.dropped
}

// Subscribers is the current fan-out width.
func (b *Broker) Subscribers() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}

func summarise(batch ledger.Batch, cursor ledger.Cursor) Update {
	update := Update{ChainID: cursor.ChainID, Block: cursor.LastBlock}

	seenRound := map[uint64]bool{}
	seenAccount := map[string]bool{}
	add := func(account string) {
		if account == "" || seenAccount[account] {
			return
		}
		seenAccount[account] = true
		update.Accounts = append(update.Accounts, account)
	}

	for _, e := range batch.Rounds {
		if !seenRound[e.RoundID] {
			seenRound[e.RoundID] = true
			update.RoundIDs = append(update.RoundIDs, e.RoundID)
		}
		add(e.Account)
	}
	// Lending entries carry no round, but a borrow or a liquidation changes
	// what a watching account's health panel should say, so they still name
	// the account.
	for _, e := range batch.Entries {
		add(e.Account)
		add(e.Counterparty)
	}
	return update
}
