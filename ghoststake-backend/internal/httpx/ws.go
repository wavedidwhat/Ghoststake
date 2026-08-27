package httpx

import (
	"context"
	"log/slog"
	"net/http"
	"slices"
	"time"

	"github.com/gorilla/websocket"

	"github.com/wavedidwhat/ghoststake/internal/auth"
	"github.com/wavedidwhat/ghoststake/internal/ledger"
	"github.com/wavedidwhat/ghoststake/internal/live"
	"github.com/wavedidwhat/ghoststake/internal/protocol"
)

// Websocket timings.
//
// A connection with no read deadline is a file descriptor a client can hold
// forever by doing nothing, which is the cheapest denial of service there is.
// The pong deadline is what closes one whose other end has gone away without
// a FIN — a laptop lid closing, a phone losing signal — which TCP alone can
// take minutes to notice and sometimes never does.
const (
	wsWriteTimeout = 10 * time.Second
	wsPongTimeout  = 60 * time.Second
	wsPingInterval = (wsPongTimeout * 9) / 10

	// wsMaxMessage bounds an inbound frame. Nothing a client sends is acted
	// on, so this is small on purpose.
	wsMaxMessage = 1024

	// wsCoalesce is how long a push waits after an update before reading and
	// sending. Several ranges can commit in quick succession during a
	// backfill, and a subscriber wants the latest state, not each step
	// towards it.
	wsCoalesce = 250 * time.Millisecond
)

// wsMessage is one push.
type wsMessage struct {
	Type string `json:"type"`
	// Block is how far the indexer had read when this was sent.
	Block   uint64      `json:"block"`
	ChainID int64       `json:"chainId"`
	AsOf    time.Time   `json:"asOf"`
	Rounds  []roundJSON `json:"rounds,omitempty"`
	// Positions is present only when the client named an address.
	Positions []positionJSON `json:"positions,omitempty"`
	Address   string         `json:"address,omitempty"`
}

// handleWS streams round updates.
//
// # Why a websocket rather than polling
//
// A round's interesting minute is its last one: the pools move with every
// entry, the odds move with the pools, and entry closes on a cutoff. Polling
// that at a useful rate means every open tab hitting the API every second or
// two, almost always to be told nothing changed.
//
// # What it sends
//
// Snapshots, not deltas. Every push carries the current state of the rounds
// that moved, read fresh from the database. That makes the protocol trivially
// recoverable — a client that missed a message, or reconnected, is correct as
// soon as the next one lands, with no replay and no sequence numbers. It costs
// more bytes than a delta stream and is worth it at this scale.
//
// # What it does not do
//
// It never reads from the client. There is nothing a subscriber can ask for
// beyond the address in the query string, so an inbound frame is either a
// control frame or noise. Not parsing client input on a long-lived connection
// removes the whole class of bug that lives there.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if s.broker == nil {
		writeError(w, http.StatusServiceUnavailable, "live updates are not configured")
		return
	}

	// An optional address the client wants its own positions for.
	var address string
	if raw := r.URL.Query().Get("address"); raw != "" {
		normalized, err := auth.NormalizeAddress(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid address")
			return
		}
		address = normalized
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade has already written its own response.
		slog.Debug("websocket upgrade failed", "err", err)
		return
	}
	defer func() { _ = conn.Close() }()

	updates, unsubscribe := s.broker.Subscribe(4)
	defer unsubscribe()

	// The read pump exists only to service pings and to notice the client
	// going away. Its return closes `done`, which stops the writer.
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn.SetReadLimit(wsMaxMessage)
		_ = conn.SetReadDeadline(time.Now().Add(wsPongTimeout))
		conn.SetPongHandler(func(string) error {
			return conn.SetReadDeadline(time.Now().Add(wsPongTimeout))
		})
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	// The opening frame is a full snapshot, so a client is correct before the
	// first update rather than after it.
	ctx := r.Context()
	if err := s.pushRounds(ctx, conn, address, nil); err != nil {
		slog.Debug("websocket initial push failed", "err", err)
		return
	}

	ping := time.NewTicker(wsPingInterval)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ping.C:
			_ = conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case update, ok := <-updates:
			if !ok {
				return
			}
			// Coalesce: drain anything that arrives in the next moment and
			// send one snapshot covering all of it.
			touched := update.Rounds
			// Checked across every coalesced update, not only the first. An
			// account named by the second one would otherwise be dropped
			// silently — the subscriber would simply never hear about their
			// own borrow.
			named := update.TouchedAccount(address)

			deadline := time.NewTimer(wsCoalesce)
			draining := true
			for draining {
				select {
				case next, ok := <-updates:
					if !ok {
						draining = false
						break
					}
					touched = mergeRounds(touched, next)
					named = named || next.TouchedAccount(address)
				case <-deadline.C:
					draining = false
				}
			}
			deadline.Stop()

			if address != "" && !relevant(touched, named) {
				continue
			}
			if err := s.pushRounds(ctx, conn, address, touched); err != nil {
				slog.Debug("websocket push failed", "err", err)
				return
			}
		}
	}
}

// pushRounds sends the current state of the named rounds, or of the most
// recent ones when nothing is named (the opening snapshot).
func (s *Server) pushRounds(ctx context.Context, conn *websocket.Conn, address string, refs []ledger.RoundRef) error {
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if len(refs) == 0 {
		recent, err := s.store.RecentRounds(readCtx, s.cfg.ChainID, "", defaultRoundLimit)
		if err != nil {
			return err
		}
		refs = recent
	}

	events, err := s.store.RoundEventsByRefs(readCtx, s.cfg.ChainID, refs)
	if err != nil {
		return err
	}

	now := time.Now().UTC()
	projected := ledger.Project(events)
	rounds := make([]roundJSON, 0, len(projected))
	byRef := map[ledger.RoundRef]ledger.Round{}
	// Params are per market and cached in the reader, so this is a map lookup
	// after the first round of each market rather than a call per round.
	paramsFor := map[string]protocol.MarketParams{}
	for _, round := range projected {
		params, ok := paramsFor[round.Market]
		if !ok {
			p, err := s.marketParamsFor(readCtx, round.Market)
			if err != nil {
				return err
			}
			paramsFor[round.Market] = p
			params = p
		}
		byRef[ledger.RoundRef{Market: round.Market, RoundID: round.RoundID}] = round
		rounds = append(rounds, renderRound(round, params, now))
	}

	message := wsMessage{
		Type:    "rounds",
		Block:   s.indexedBlock(readCtx),
		ChainID: s.cfg.ChainID,
		AsOf:    now,
		Rounds:  rounds,
		Address: address,
	}
	if address != "" {
		for _, position := range ledger.ProjectPositions(events, address) {
			ref := ledger.RoundRef{Market: position.Market, RoundID: position.RoundID}
			round, ok := byRef[ref]
			if !ok {
				continue
			}
			message.Positions = append(message.Positions, renderPosition(position, round, paramsFor[round.Market], now))
		}
	}

	_ = conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	return conn.WriteJSON(message)
}

// relevant decides whether a client watching one address needs this push.
//
// A client that named an address still gets every round update: the pools it
// is staked against move because of other people's entries, and its payout
// quote moves with them. The filter is only about ranges that touched neither
// a round nor this account — a lending event for somebody else — and it is
// deliberately permissive, because a spurious push costs a message and a
// missing one costs a wrong number on someone's screen.
func relevant(touchedRounds []ledger.RoundRef, namedAccount bool) bool {
	return len(touchedRounds) > 0 || namedAccount
}

func mergeRounds(into []ledger.RoundRef, update live.Update) []ledger.RoundRef {
	for _, ref := range update.Rounds {
		if !slices.Contains(into, ref) {
			into = append(into, ref)
		}
	}
	return into
}
