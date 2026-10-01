<p align="center">
  <img src="ghoststake-frontend/src/app/icon.svg" alt="GhostStake" width="96" height="96">
</p>

<h1 align="center">GhostStake</h1>

<p align="center">
  Staking, lending and short price markets on <strong>Robinhood Chain</strong>.<br>
  Your collateral keeps working while you use it.
</p>

<p align="center">
  <a href="https://testnet.ghoststake.xyz">testnet.ghoststake.xyz</a>
</p>

---

## What it is

You deposit into a vault and earn yield. You can borrow against that position
without unstaking, and you can put what you borrowed into short, hourly price
markets such as "ETH above $1,990 at 9:05 AM". You can also borrow stablecoins
against tokenized stocks (Tesla, Amazon, AMD, Palantir) using each stock's real
price.

| Part | What it does |
|---|---|
| **Stake** | An ERC-4626 vault. Deposit, earn yield that accrues lazily, withdraw. |
| **Lend** | A shared liquidity pool with a kinked rate curve. Lenders earn what borrowers pay. |
| **Borrow** | Borrow against a position with an LTV ceiling and a health factor. |
| **Liquidate** | Permissionless. Anyone can close an unhealthy position and earn a bonus. |
| **Markets** | Four-phase parimutuel rounds on a price or a yes/no question. Winners split the losers' pool; there is no house. |
| **Stocks** | Borrow stablecoins against Robinhood stock tokens. Bad debt is covered by selling the seized collateral and paying the cash to lenders. |
| **Portfolio and activity** | Every position, bet and transaction an address has made, with each hash linked to the explorer. |
| **Operator console** | Drive rounds and markets without a terminal. |

## Built to be checked

- **A settler cannot choose the price.** A round settles against a named
  Chainlink round, not "the latest price".
- **A round with no honest answer voids and refunds.** It does not guess.
- **An emergency stop can only stop people arriving.** It never traps funds
  already inside.
- **Fees are stated before you sign.**
- **Owner powers are written down** in the contracts, not left implicit.

## Where it runs

Robinhood Chain **testnet** (chain ID `46630`). There is no mainnet deployment
and the contracts are unaudited.

Chainlink has no equity feeds on Robinhood testnet, so a mirror reads the real
mainnet price and republishes it onto a testnet feed with mainnet's own
timestamp. The number is Robinhood's equity price; only the transport is ours.
The app badges these feeds rather than passing them off as Chainlink.

## Repository

Monorepo. Each package is self-contained, with its own Dockerfile and compose
setup, and deploys independently.

| Package | Stack | Notes |
|---|---|---|
| [`ghoststake-contracts/`](ghoststake-contracts) | Solidity, Foundry | Vault, pool, rounds, registry, oracles, stock loans. `forge fmt` and `forge test` enforced in CI; Slither runs non-blocking |
| [`ghoststake-backend/`](ghoststake-backend) | Go 1.27, chi, Postgres | Event indexer and append-only ledger, HTTP API ([`openapi.yaml`](ghoststake-backend/openapi.yaml)), SIWE wallet auth, round keeper, price mirror. `make lint`/`test`/`build` enforced in CI |
| [`ghoststake-frontend/`](ghoststake-frontend) | Next.js 16, React, Tailwind v4 | App Router. English, Spanish, Portuguese (Brazil) and Chinese. Lint, typecheck, unit and browser tests enforced in CI |

The backend ships three binaries: the **API and indexer**, the **keeper**
(opens, locks and closes rounds) and the **mirror** (publishes stock prices).
The keeper and mirror run in their own containers, so a crash in one does not
stop the others.

## Getting started

The fastest path to a running system is the local stack: it starts anvil,
deploys every contract, seeds real positions and a live round, and writes the
env files the frontend and backend read.

```bash
./scripts/local-stack.sh

cd ghoststake-frontend && pnpm install && pnpm dev     # :3000
cd ghoststake-backend  && make run-local               # :8080, indexer on
cd ghoststake-backend  && make run-keeper-local        # drives the rounds
```

The keeper is optional but is what makes the local stack *move*: without it
the seeded round sits open until somebody locks it by hand from `/operator`.

anvil holds state in memory, so restarting it resets the world and the
addresses change. Re-run the script rather than repairing a local chain.

To see a funded position, import the anvil key the script prints and add a
network on chain `31337` at `http://127.0.0.1:8545`.

Per package, without the local stack:

```bash
# frontend
cd ghoststake-frontend && pnpm install && pnpm dev     # :3000

# backend
cd ghoststake-backend && cp .env.example .env          # set JWT_SECRET
make up                                                 # :8080

# contracts
cd ghoststake-contracts && forge test
```

Each package has its own README with details.

## Chain

Robinhood Chain, an Ethereum L2 built on Arbitrum Nitro. Standard EVM tooling
applies.

| Network | Chain ID |
|---|---|
| Robinhood Chain testnet | `46630` |

The backend verifies its configured `CHAIN_ID` against the RPC on startup and
refuses to boot on mismatch.

## Conventions

- **No host ports in `docker-compose.yml`.** Traefik routes to containers over
  the shared proxy network, so the container port never competes for a host
  port. Local port bindings live in `docker-compose.override.yml`, which Compose
  auto-loads for a bare `docker compose up` but ignores when files are passed
  explicitly with `-f` (how deploys work).
- **Secrets never land in git.** Commit `.env.example`; keep real values in
  `.env`, which is ignored.
- **New work happens on a branch per issue, merged via PR.** CI must pass
  before merge; `main` is protected. Branch names follow the Linear branch
  name (e.g. `gho-11-nextjs-scaffold-and-wallet-connect`).
- **Commits don't carry AI co-author trailers.** Run
  `git config core.hooksPath .githooks` once per clone — it strips them via
  a `prepare-commit-msg` hook.
