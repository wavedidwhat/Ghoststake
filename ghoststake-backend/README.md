# GhostStake — Backend

Go API for GhostStake, an on-chain staking product on **Arbitrum**.

Current scope: wallet authentication (SIWE), an append-only chain indexer over
the vault, the borrow pool and the parimutuel market, a read API that serves
rounds, positions and lending health — with a websocket for live round updates
— and a keeper that drives round phase transitions on a timer.

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
cmd/keeper/        entrypoint: the round keeper, the only process with a key
cmd/genabi/        copies contract ABIs out of the forge artifacts
internal/config/   env config, fails fast on bad values
internal/auth/     SIWE message, signature recovery, JWT
internal/abis/     embedded contract ABIs, shared by the indexer and the reader
internal/ledger/   the append-only domain: entries, round events, projections
internal/finance/  the money rules: yield, debt, health factor, payouts
internal/indexer/  log polling, reorg handling, decoding
internal/keeper/   round lifecycle rules, feed search, market-hours calendar
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

Against the local anvil stack (`scripts/local-stack.sh` from the repo root):

```bash
make run-local            # the API and indexer
make run-keeper-local     # the keeper, in another terminal
```

## The keeper

Contracts do not run on a schedule — `ParimutuelRound` only moves when
somebody sends it a transaction. `cmd/keeper` is a timer that opens rounds,
locks them at `lockTime`, and resolves them against the feed round pinned to
`closeTime`. Rounds overlap: the next one opens as the current one's entry
window closes, so there is always one taking positions.

Three things about it are worth knowing.

**It is a convenience, not a privilege.** `lockRound`, `resolveRound` and
`voidUnlockedRound` are permissionless in the contract, and the keeper does
not change that. If it dies, any user can advance their own round from the
operator console at `/operator`. Only `openRound` and `voidUnsettledRound` are
owner-gated, and a keeper without the owner key simply declines them.

**It is the only process in this repo that holds a key.** The API, the indexer
and the protocol reader are strictly read-only, and the keeper is a separate
binary, a separate image and a separate container so that stays true. Its
configuration lives in `.env.keeper`, never in `.env` — see
`.env.keeper.example`.

**Chainlink Automation is the production answer.** A self-hosted keeper is a
single point of failure. This one exists because the protocol is built so a
keeper outage costs liveness and not safety, and because knowing the
difference is worth showing.

It needs no database. Every decision comes from the chain, so it can be
restarted or moved with nothing to reconcile, and a second instance racing it
simply loses and logs that the round was already locked.

```bash
docker compose -f docker-compose.yml -f docker-compose.keeper.yml up -d
```

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

The full contract is [`openapi.yaml`](openapi.yaml) — request and response
shapes, status codes, and the websocket frame format. It is checked against the
router by `TestOpenAPIMatchesTheRegisteredRoutes`, so an endpoint added without
being documented fails CI rather than quietly making the spec a lie.

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
raw number would silently lose its low digits in `JSON.parse`. Parse them with
`BigInt()`.

`healthFactor` and `ltv` are **`null` when there is no debt**, not a very large
number. The contract returns `type(uint256).max`, which is right on-chain and a
78-digit integer in JSON that every consumer would have to special-case.
`hasDebt` says which case you are in.

Indexed responses are deliberately **behind the chain head** — the indexer
stays `INDEXER_CONFIRMATIONS` blocks back, because a shallower block can still
be reorged out. `indexedBlock` and `asOf` are on every one of them, and a UI
should show them rather than implying the numbers are live: a user who has just
staked and cannot see it yet has found the confirmation lag, not a bug.
`/api/v1/health/{address}` is the exception — it reads the chain directly, with
every call in the request pinned to one block, and reports that block.

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

The keeper reads its own environment (`config.LoadKeeper`), not the API's. It
requires `KEEPER_PRIVATE_KEY` and either `REGISTRY_ADDRESS` or
`KEEPER_MARKET_ADDRESSES`, and refuses to start if its poll interval is not
shorter than a market's lock window — a keeper polling slower than that voids
every round it is meant to settle.

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
