#!/usr/bin/env bash
#
# Adds a market registry (GHO-34) to a deployment that is already live, and
# lists the markets already running on it.
#
#   NETWORK=ethereum-sepolia ./scripts/deploy-registry.sh
#
# One new contract and a listing per market. Nothing existing is touched:
# positions stand, the indexer keeps its cursor, and the markets themselves
# never learn the registry exists.
#
# Once the frontend is rebuilt with the address this prints, the four
# NEXT_PUBLIC_*_ADDRESS market variables stop being read — the list comes from
# the chain, and adding a market becomes a transaction.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="${NETWORK:-ethereum-sepolia}"

case "$NETWORK" in
  local)             RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"; CHAIN_ID=31337 ;;
  ethereum-sepolia)  RPC_URL="${RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"; CHAIN_ID=11155111 ;;
  robinhood-testnet) RPC_URL="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"; CHAIN_ID=46630 ;;
  arbitrum-sepolia)  RPC_URL="${RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}"; CHAIN_ID=421614 ;;
  *) echo "unknown NETWORK '$NETWORK'" >&2; exit 1 ;;
esac

export ARBISCAN_API_KEY="${ARBISCAN_API_KEY:-}"
log() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }

ENV_FILE="$ROOT/ghoststake-frontend/.env.local"
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE — deploy first, or set the addresses by hand" >&2; exit 1; }
get() { grep -E "^$1=" "$ENV_FILE" | cut -d= -f2; }

# The markets the app is actually pointed at. Reading them from the same file
# the frontend reads means the registry lists what is on screen, rather than
# whatever was in a shell an hour ago.
export MARKET_ADDRESS="${MARKET_ADDRESS:-$(get NEXT_PUBLIC_MARKET_ADDRESS)}"
export ROUTER_ADDRESS="${ROUTER_ADDRESS:-$(get NEXT_PUBLIC_ROUTER_ADDRESS)}"
export DEMO_MARKET_ADDRESS="${DEMO_MARKET_ADDRESS:-$(get NEXT_PUBLIC_DEMO_MARKET_ADDRESS)}"
export DEMO_ROUTER_ADDRESS="${DEMO_ROUTER_ADDRESS:-$(get NEXT_PUBLIC_DEMO_ROUTER_ADDRESS)}"

if [ -z "$MARKET_ADDRESS" ] || [ -z "$ROUTER_ADDRESS" ]; then
  echo "no market and router in $ENV_FILE — a registry with nothing in it is not worth deploying" >&2
  exit 1
fi

# `tail -1` so a file that already holds the key twice does not produce a
# two-line "address". That is not hypothetical: the deploy scripts write the
# key empty, and appending a second one here is what this function then read.
get_last() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2; }

EXISTING="$(get_last NEXT_PUBLIC_REGISTRY_ADDRESS)"
if [ -n "$EXISTING" ]; then
  # Refused rather than replaced: a second registry orphans whatever the first
  # one listed, and only a human knows whether that is intended.
  echo "a registry is already configured at $EXISTING" >&2
  echo "to replace it, clear NEXT_PUBLIC_REGISTRY_ADDRESS from $ENV_FILE first" >&2
  exit 1
fi

cd "$ROOT/ghoststake-contracts"
if [ "$NETWORK" = "local" ]; then
  export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
else
  set -a && . ./.env && set +a
fi
[ -n "${PRIVATE_KEY:-}" ] || { echo "PRIVATE_KEY is not set in ghoststake-contracts/.env" >&2; exit 1; }

DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
ACTUAL_CHAIN="$(cast chain-id --rpc-url "$RPC_URL")"
if [ "$ACTUAL_CHAIN" != "$CHAIN_ID" ]; then
  echo "RPC reports chain $ACTUAL_CHAIN, expected $CHAIN_ID" >&2
  exit 1
fi

log "network   $NETWORK (chain $CHAIN_ID)"
log "market    $MARKET_ADDRESS"
[ -n "$DEMO_MARKET_ADDRESS" ] && log "demo      $DEMO_MARKET_ADDRESS"
log "deployer  $DEPLOYER — becomes the registry owner, and the only key that can list"

if ! OUT="$(forge script script/DeployRegistry.s.sol:DeployRegistry --rpc-url "$RPC_URL" \
    --broadcast --slow --gas-estimate-multiplier 200 2>&1)"; then
  echo "$OUT" >&2
  exit 1
fi

REGISTRY="$(echo "$OUT" | grep -oE 'NEXT_PUBLIC_REGISTRY_ADDRESS=0x[0-9a-fA-F]{40}' | cut -d= -f2)"
if [ -z "$REGISTRY" ]; then
  echo "$OUT" >&2
  echo "could not parse the registry address — see output above" >&2
  exit 1
fi

log "updating $ENV_FILE"
# Rewritten in place where the key exists — the deploy scripts write it empty
# — rather than appended. Two copies of one key is a config file that means
# two things at once, and which one wins depends on who is reading it.
if grep -qE '^NEXT_PUBLIC_REGISTRY_ADDRESS=' "$ENV_FILE"; then
  sed -i.bak -E "s|^NEXT_PUBLIC_REGISTRY_ADDRESS=.*|NEXT_PUBLIC_REGISTRY_ADDRESS=$REGISTRY|" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
else
  echo "NEXT_PUBLIC_REGISTRY_ADDRESS=$REGISTRY" >>"$ENV_FILE"
fi

LISTED="$(cast call "$REGISTRY" 'count()(uint256)' --rpc-url "$RPC_URL")"

cat <<SUMMARY

  $(printf '\033[1;32m✓ registry deployed to %s\033[0m' "$NETWORK")

  MarketRegistry        $REGISTRY
  markets listed        $LISTED

  The frontend bakes this in at build time, so rebuild the image with:

    NEXT_PUBLIC_REGISTRY_ADDRESS=$REGISTRY

  With it set, the four NEXT_PUBLIC_*_ADDRESS market variables are ignored
  and the list comes from the chain. Adding a market is then a transaction:

    cast send $REGISTRY 'list(address,address,uint64)' <market> <router> <seconds> \\
      --private-key \$PRIVATE_KEY --rpc-url $RPC_URL

SUMMARY
