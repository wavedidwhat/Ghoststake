# ghoststake-contracts

Solidity contracts for GhostStake, built with [Foundry](https://getfoundry.sh).

## Layout

| Dir | Contents |
|---|---|
| `src/` | Contracts |
| `test/` | Foundry tests (`*.t.sol`) |
| `script/` | Deploy / operational scripts (`*.s.sol`) |

## Local setup

```bash
# Install Foundry if you don't have it
curl -L https://foundry.paradigm.xyz | bash
foundryup

cd ghoststake-contracts
forge install          # pulls lib/ dependencies (forge-std, etc.)
cp .env.example .env   # fill in RPC URLs / keys as needed for scripts

forge build
forge test
```

## Conventions

- Format with `forge fmt` before committing; CI runs `forge fmt --check` and
  fails the build on drift.
- `forge test` must stay green on a fresh clone with no `.env` present —
  tests should never depend on secrets or live RPCs.
- [Slither](https://github.com/crytic/slither) runs in CI as a non-blocking
  job for now; findings are informational until the ruleset is tuned.
- Real RPC URLs and keys go in `.env` (gitignored). `.env.example` documents
  what's needed and must never contain real values.

## Chain

Arbitrum. `foundry.toml` has RPC/Etherscan endpoints configured for both
networks, sourced from environment variables:

| Network | Chain ID |
|---|---|
| Arbitrum One (mainnet) | `42161` |
| Arbitrum Sepolia (testnet) | `421614` |
