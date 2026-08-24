# GhostStake — Backend

Go API for GhostStake, an on-chain staking product on **Arbitrum**.

Current scope: runnable service skeleton + wallet authentication (SIWE).
Staking domain logic is not built yet.

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
internal/config/   env config, fails fast on bad values
internal/auth/     SIWE message, signature recovery, JWT
internal/store/    Postgres: users, nonces, migrations
internal/chain/    Arbitrum RPC client
internal/httpx/    server, routes, middleware, handlers
migrations/        embedded SQL
```

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

1. Staking domain: pools, positions, stake/unstake/claim
2. Contract bindings via `abigen` once contracts are deployed
3. Indexer worker to persist chain state instead of reading per request
