# GhostStake

On-chain staking on **Arbitrum**.

Monorepo. Each service is self-contained, with its own Dockerfile and compose
setup, and deploys independently.

| Package | Stack | Notes |
|---|---|---|
| [`ghoststake-frontend/`](ghoststake-frontend) | Next.js 16, App Router, Tailwind v4 | `shadcn/typeset` for rendered markdown; lint/typecheck/build enforced in CI |
| [`ghoststake-backend/`](ghoststake-backend) | Go 1.25, chi, Postgres | SIWE wallet auth, Arbitrum RPC; `make lint`/`test`/`build` enforced in CI |
| [`ghoststake-contracts/`](ghoststake-contracts) | Solidity, Foundry | Arbitrum, `forge fmt`/`forge test` enforced in CI |

## Getting started

```bash
# frontend
cd ghoststake-frontend && pnpm install && pnpm dev     # :3000

# backend
cd ghoststake-backend && cp .env.example .env          # set JWT_SECRET
make up                                                 # :8080

# contracts
cd ghoststake-contracts && cp .env.example .env        # only needed for deploy scripts
forge test
```

Each package has its own README with details.

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

## Chain

Arbitrum, an Ethereum L2 — standard EVM tooling applies.

| Network | Chain ID |
|---|---|
| Arbitrum One (mainnet) | `42161` |
| Arbitrum Sepolia (testnet) | `421614` |

The backend verifies its configured `CHAIN_ID` against the RPC on startup and
refuses to boot on mismatch.
