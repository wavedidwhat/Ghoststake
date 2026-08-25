#!/usr/bin/env bash
#
# Brings up a complete local GhostStake: anvil, the contracts, seeded
# activity, and the env files the frontend and backend read.
#
# Everything here is disposable. anvil holds state in memory, so stopping it
# resets the world — which is the point: re-run this instead of trying to
# repair a local chain.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
ANVIL_PORT="${ANVIL_PORT:-8545}"

# foundry.toml interpolates this for its [etherscan] block even on a local
# run that never verifies anything, so it has to be set to something.
export ARBISCAN_API_KEY="${ARBISCAN_API_KEY:-}"

# anvil's first prefunded account, forced rather than defaulted.
#
# forge auto-loads ghoststake-contracts/.env, so a PRIVATE_KEY left there for
# a testnet deploy would be picked up here too — and that key has no gas on
# anvil, so the whole local stack fails with "insufficient funds" while
# appearing to be misconfigured locally. Exporting it explicitly means the
# local chain always uses the local account, whatever .env holds.
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Both markets locally, even though anvil's clock can be warped and the local
# feed is already operator-driven. What is being developed against is a
# deployment with two markets in it, and a UI that only ever sees one is a UI
# whose market labelling nobody looks at until it is in front of an audience.
export DEMO_MARKET="${DEMO_MARKET:-true}"

log() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------- anvil ----
if cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  log "anvil already running on $RPC_URL"
else
  log "starting anvil on port $ANVIL_PORT"
  anvil --port "$ANVIL_PORT" --silent >"${TMPDIR:-/tmp}/ghoststake-anvil.log" 2>&1 &
  until cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1; do sleep 1; done
fi

# --------------------------------------------------------------- deploy ----
log "deploying contracts"
cd "$ROOT/ghoststake-contracts"
if ! DEPLOY_OUT="$(forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL" --broadcast 2>&1)"; then
  # Printed, not swallowed: the output is captured to parse addresses out of
  # it, which otherwise hides the reason for any failure behind `set -e`.
  echo "$DEPLOY_OUT" >&2
  exit 1
fi

# Parsed from the script's own log lines rather than the broadcast JSON: the
# JSON keys contracts by name, and two mocks share a base contract, so the
# labelled output is the unambiguous source.
addr_of() { echo "$DEPLOY_OUT" | grep -E "^\s+$1\s+0x" | awk '{print $NF}'; }

ASSET=$(addr_of "Asset")
POOL=$(addr_of "BorrowLiquidityPool")
VAULT=$(addr_of "CollateralVault")
# `|| true` on each, unlike the addresses above: these three are absent
# whenever the demo market is off, and `grep` finding nothing is a failed
# pipeline. Under `set -o pipefail` that takes the whole script down at the
# assignment — silently, before anything is printed.
DEMO_FEED=$(addr_of "DemoPriceFeed" || true)
DEMO_MARKET_ADDR=$(addr_of "DemoParimutuelRound" || true)
DEMO_ROUTER=$(addr_of "DemoBorrowToPosRtr" || true)
REGISTRY=$(addr_of "MarketRegistry" || true)
MARKET=$(addr_of "ParimutuelRound")
ROUTER=$(addr_of "BorrowToPositionRtr")
ORACLE=$(addr_of "ChainlinkRoundOracle")

if [ -z "$VAULT" ] || [ -z "$POOL" ] || [ -z "$MARKET" ]; then
  echo "$DEPLOY_OUT" >&2
  echo "could not parse deployed addresses — see output above" >&2
  exit 1
fi

# ----------------------------------------------------------------- seed ----
#
# Mine first, so the seed simulates against a current clock.
#
# forge simulates against the latest block, and anvil only mines when asked —
# so a chain that has been idle reports a stale timestamp. The seed opens a
# round at that timestamp, the next block jumps the clock forward to real
# time, and `openRound` rejects an open time that is now in the past. It
# surfaces as a bare `InvalidSchedule` with the script's output swallowed by
# the `sed` below, which is a miserable half hour to debug.
cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null

log "seeding activity"
export ASSET_ADDRESS="$ASSET" POOL_ADDRESS="$POOL" VAULT_ADDRESS="$VAULT" MARKET_ADDRESS="$MARKET"

# Captured, not piped straight into `sed`: a failing forge script under
# `pipefail` takes the whole script down, and with its output consumed by the
# range pattern there is nothing left to say why. That happened twice.
if ! SEED_OUT="$(forge script script/Seed.s.sol:Seed --rpc-url "$RPC_URL" --broadcast 2>&1)"; then
  echo "$SEED_OUT" >&2
  exit 1
fi
echo "$SEED_OUT" | sed -n '/=== seeded ===/,/^  bob/p'

# The round is opened with a lead and staked in a second pass, because
# `openRound` refuses a start in the past and `takePosition` refuses one
# before entry opens — a window narrower than the gap between simulating a
# transaction and mining it. Warping between the two is what makes it fit.
SEED_ROUND="$(echo "$SEED_OUT" | grep -oE 'SEED_ROUND=[0-9]+' | head -1 | cut -d= -f2)"
if [ -n "$SEED_ROUND" ]; then
  cast rpc evm_increaseTime 130 --rpc-url "$RPC_URL" >/dev/null
  cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
  if ! STAKE_OUT="$(SEED_ROUND="$SEED_ROUND" forge script script/Seed.s.sol:Seed --sig 'stakeRound()' \
      --rpc-url "$RPC_URL" --broadcast 2>&1)"; then
    echo "$STAKE_OUT" >&2
    exit 1
  fi
  echo "$STAKE_OUT" | sed -n '/=== staked ===/,/round #/p'
fi

# ------------------------------------------------------------ env files ----
# Written rather than printed. Copying six addresses by hand is how a local
# environment ends up pointed at yesterday's deploy.
log "writing ghoststake-frontend/.env.local"
cat >"$ROOT/ghoststake-frontend/.env.local" <<ENV
# Generated by scripts/local-stack.sh — re-run it after every anvil restart.
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_RPC_URL=$RPC_URL
NEXT_PUBLIC_VAULT_ADDRESS=$VAULT
NEXT_PUBLIC_POOL_ADDRESS=$POOL
NEXT_PUBLIC_MARKET_ADDRESS=$MARKET
NEXT_PUBLIC_ROUTER_ADDRESS=$ROUTER
NEXT_PUBLIC_DEMO_MARKET_ADDRESS=$DEMO_MARKET_ADDR
NEXT_PUBLIC_DEMO_ROUTER_ADDRESS=$DEMO_ROUTER
NEXT_PUBLIC_DEMO_FEED_ADDRESS=$DEMO_FEED
# With this set, the four addresses above are ignored and the market list is
# read from the chain instead (GHO-34).
NEXT_PUBLIC_REGISTRY_ADDRESS=$REGISTRY
ENV

log "writing ghoststake-backend/.env.local"
cat >"$ROOT/ghoststake-backend/.env.local" <<ENV
# Generated by scripts/local-stack.sh. Source it alongside your own .env:
#   set -a && . .env && . .env.local && set +a && make run
CHAIN_ID=31337
ARBITRUM_RPC_URL=$RPC_URL
INDEXER_ENABLED=true
INDEXER_START_BLOCK=1
INDEXER_CONFIRMATIONS=0
INDEXER_POLL_INTERVAL=3s
VAULT_ADDRESS=$VAULT
POOL_ADDRESS=$POOL
MARKET_ADDRESS=$MARKET
ENV

cat <<SUMMARY

  $(printf '\033[1;32m✓ local stack is up\033[0m')

  MockUSDC              $ASSET
  BorrowLiquidityPool   $POOL
  CollateralVault       $VAULT
  ChainlinkRoundOracle  $ORACLE
  ParimutuelRound       $MARKET
  BorrowToPositionRtr   $ROUTER
  DemoPriceFeed         ${DEMO_FEED:-(none)}
  Demo ParimutuelRound  ${DEMO_MARKET_ADDR:-(none)}
  Demo router           ${DEMO_ROUTER:-(none)}
  MarketRegistry        ${REGISTRY:-(none)}

  Frontend    cd ghoststake-frontend && pnpm dev      → http://localhost:3000
  Backend     cd ghoststake-backend  && make run-local

  To see a funded position, import this anvil key into your wallet and
  add a network on chain 31337 at $RPC_URL:

    alice  0x70997970C51812dc3A010C7d01b50e0d17dc79C8
           0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
           10,000 mUSDC deposited, 3,000 borrowed, health factor 2.67

  These keys are anvil's published test accounts. They are public knowledge
  and must never hold anything real.

SUMMARY
