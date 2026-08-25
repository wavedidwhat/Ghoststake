# GhostStake — Backend

Go API for GhostStake, an on-chain staking product on **Arbitrum**.

Current scope: wallet authentication (SIWE), an append-only chain indexer over
the vault, the borrow pool and the parimutuel market, and a read API that
serves rounds, positions and lending health — with a websocket for live round
updates.

## Stack

| Piece | Choice | Why |
|---|---|---|
| Language | Go 1.27 | |
| Router | `chi` | stdlib-compatible `http.Handler`, no framework lock-in |
| Database | Postgres via `pgx/v5` | |
| Migrations | `goose`, embedded | schema ships inside the binary |
| Chain | `go-ethereum` JSON-RPC | Arbitrum is EVM, so the standard client works |
| Auth | SIWE (EIP-4361) + JWT | wallet signature, no passwords |

## Layout

```
cmd/api/           entrypoint: wiring, graceful shutdown
cmd/genabi/        copies contract ABIs out of the forge artifacts
internal/config/   env config, fails fast on bad values
internal/auth/     SIWE message, signature recovery, JWT
internal/abis/     embedded contract ABIs, shared by the indexer and the reader
internal/ledger/   the append-only domain: entries, round events, projections
internal/finance/  the money rules: yield, debt, health factor, payouts
internal/indexer/  log polling, reorg handling, decoding
internal/protocol/ live contract reads, pinned to one block
internal/live/     fan-out from the indexer to websocket subscribers
internal/store/    Postgres: users, nonces, ledger, round events, migrations
internal/chain/    Arbitrum RPC client and contract calls
internal/httpx/    server, routes, middleware, handlers
migrations/        embedded SQL
```

### Where the rules live

`internal/finance` holds every financial rule — accrual, debt scaling, health
factors, borrowing room, parimutuel payouts — and imports nothing but the
standard library. No HTTP, no SQL, no chain client. It is a straight
reimplementation of the contracts' arithmetic, in the same fixed-point maths
and with the same rounding, so it can be read and tested on its own.

A reimplementation drifts, so it is checked against the original:
`internal/protocol/live_test.go` calls the deployed contracts' own views and
asserts this package produces the identical figure for the identical inputs, at
one pinned block. Run it with `make test-live`.

### Debt is reported larger than the contract's view says

`balanceOfDebt`, `healthFactor` and `maxBorrowable` all read the pool's *stored*
interest index, which is only current when someone last poked the pool. Every
mutating path — including `liquidate` and `borrow` — calls `accrue()` first, so
the numbers those transactions actually use are larger.

The API therefore reports the accrued figures, with the contract's view beside
them (`debtAtStoredIndex`, `pendingInterest`). Serving the view would tell a
borrower they are safe at 1.02 while a liquidator finds them at 0.99, and would
offer a "borrow max" that reverts.

## Running

```bash
cp .env.example .env
openssl rand -hex 32          # put in JWT_SECRET
make up                       # api + postgres
curl localhost:8080/readyz
```

Without Docker: point `DATABASE_URL` at a Postgres and `make run`.

## Auth flow

Three steps. The client never sends the address or the message at verify time —
both are looked up server-side from the nonce.

```
POST /api/v1/auth/nonce    {address}            -> {nonce, message, expiresAt}
     wallet signs `message` with personal_sign
POST /api/v1/auth/verify   {nonce, signature}   -> {token, address, expiresAt}
GET  /api/v1/me            Bearer <token>       -> {address, createdAt, lastLoginAt}
```

Properties this gives you:

- **Nonces are single-use.** Claimed with one atomic `UPDATE ... WHERE
  consumed_at IS NULL RETURNING`, so concurrent replays cannot both win.
- **Signatures are origin-bound.** Domain, URI and chain ID are inside the
  signed text, so a signature phished elsewhere is not valid here.
- **Server-side message.** Verification compares against the message the server
  stored, so there is no untrusted-input parser to get wrong.
- **Addresses are EIP-55 normalized**, so one wallet is always one row.
- **Auth endpoints are rate limited** per IP (20/min).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | – | liveness; touches no dependencies |
| GET | `/readyz` | – | readiness; pings the database |
| POST | `/api/v1/auth/nonce` | – | issue login challenge |
| POST | `/api/v1/auth/verify` | – | verify signature, issue JWT |
| GET | `/api/v1/me` | Bearer | current wallet |
| GET | `/api/v1/rounds` | – | recent rounds, pools, odds and phase |
| GET | `/api/v1/positions/{address}` | – | one wallet's rounds, open and historical |
| GET | `/api/v1/health/{address}` | – | health factor, collateral, debt, accrued yield |
| GET | `/api/v1/ws` | – | websocket; live round snapshots |

The read endpoints are unauthenticated: everything they serve is derived from
public chain state, and requiring a login to read a public blockchain would be
theatre. They are rate limited per IP (120/min) because each one costs a
database read or an RPC call. `?limit=` on the two listings is clamped.

Every uint256 crosses the wire as a **decimal string**. JSON numbers are
doubles, and a balance in wei exceeds their 53 bits of integer precision — a
raw number would silently lose its low digits in `JSON.parse`.

`/api/v1/ws` accepts an optional `?address=`, and then includes that wallet's
positions alongside the rounds. It sends whole snapshots rather than deltas, so
a client that missed a message or reconnected is correct as soon as the next
one arrives. Its origin check uses `CORS_ORIGINS`: the websocket handshake is
not subject to CORS, so the browser would not enforce it for us.

## Configuration

See `.env.example`. `JWT_SECRET` is required (min 32 bytes) whenever
`APP_ENV` is not `development`; the service refuses to boot without it.

`CHAIN_ID` is checked against the RPC on startup and the service exits on
mismatch, so a wrong endpoint fails loudly instead of silently reading the
wrong network. `421614` = Arbitrum Sepolia, `42161` = Arbitrum One.

## Deployment

`docker-compose.yml` publishes **no host ports** — Traefik routes to the
container over the proxy network. `docker-compose.override.yml` adds local port
bindings and is auto-loaded only for a bare `docker compose up`, never for a
deploy that passes `-f` explicitly.

The image is `distroless/static:nonroot` (~16MB): static binary, no shell, no
package manager, non-root.

## Next

1. Point the frontend at these endpoints instead of reading the chain per page
2. Round-level websocket subscriptions, so a client watching one round is not
   sent every round
3. Serve the lending books from the ledger where an event exists for them,
   rather than calling the chain
