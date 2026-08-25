#!/usr/bin/env bash
#
# Adds the demo market (GHO-29) to a deployment that is already live.
#
#   NETWORK=ethereum-sepolia ./scripts/deploy-demo-market.sh
#
# Four new contracts — the operator-driven feed, its adapter, the round
# contract and a router — attached to the asset and vault that already exist.
# Nothing else is touched: existing positions stand, and the indexer keeps its
# cursor, because none of the addresses it was started on change.
#
# Re-running this deploys a *second* demo market rather than replacing the
# first. That is deliberate — nothing here can tell a stale demo market from a
# deliberate new one, and silently orphaning a market people hold positions in
# is not a decision a script should make. Delete the old addresses by hand.
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
export SEQUENCER_FEED_ADDRESS="${SEQUENCER_FEED_ADDRESS:-}"
log() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }

ENV_FILE="$ROOT/ghoststake-frontend/.env.local"

# The vault the app is actually pointed at, so the demo market cannot end up
# attached to a deployment nobody is looking at.
if [ -z "${VAULT_ADDRESS:-}" ]; then
  [ -f "$ENV_FILE" ] || { echo "no VAULT_ADDRESS and no $ENV_FILE to read one from" >&2; exit 1; }

  # Only if the file describes this network. It is rewritten by every local
  # run, so after an afternoon of `local-stack.sh` it holds anvil addresses —
  # and a demo market attached to a vault that does not exist here is a market
  # whose every position reverts.
  ENV_CHAIN="$(grep -E '^NEXT_PUBLIC_CHAIN_ID=' "$ENV_FILE" | tail -1 | cut -d= -f2)"
  if [ -n "$ENV_CHAIN" ] && [ "$ENV_CHAIN" != "$CHAIN_ID" ]; then
    echo "$ENV_FILE describes chain $ENV_CHAIN, but NETWORK=$NETWORK is chain $CHAIN_ID." >&2
    echo "Pass VAULT_ADDRESS explicitly, or re-generate the file for this network." >&2
    exit 1
  fi

  VAULT_ADDRESS="$(grep -E '^NEXT_PUBLIC_VAULT_ADDRESS=' "$ENV_FILE" | tail -1 | cut -d= -f2)"
fi
[ -n "$VAULT_ADDRESS" ] || { echo "VAULT_ADDRESS is empty" >&2; exit 1; }
export VAULT_ADDRESS

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

# The deployer becomes the feed's owner, and only the owner can publish. A
# demo market whose feed answers to a key nobody has on the night is a market
# that cannot resolve at all, so this is stated before anything is signed.
log "network   $NETWORK (chain $CHAIN_ID)"
log "vault     $VAULT_ADDRESS"
log "deployer  $DEPLOYER — this key, and only this key, can push prices"

if ! OUT="$(forge script script/DeployDemoMarket.s.sol:DeployDemoMarket --rpc-url "$RPC_URL" \
    --broadcast --slow --gas-estimate-multiplier 200 2>&1)"; then
  echo "$OUT" >&2
  exit 1
fi

addr_of() { echo "$OUT" | grep -E "^\s+$1\s+0x" | awk '{print $NF}'; }
DEMO_FEED=$(addr_of "DemoPriceFeed")
DEMO_MARKET=$(addr_of "DemoParimutuelRound")
DEMO_ROUTER=$(addr_of "DemoBorrowToPosRtr")

if [ -z "$DEMO_MARKET" ] || [ -z "$DEMO_ROUTER" ] || [ -z "$DEMO_FEED" ]; then
  echo "$OUT" >&2
  echo "could not parse the deployed addresses — see output above" >&2
  exit 1
fi

# Rewritten in place rather than appended: a second copy of the same key with
# a different value is a config file that means two things at once.
if [ -f "$ENV_FILE" ]; then
  log "updating $ENV_FILE"
  set_env() {
    if grep -qE "^$1=" "$ENV_FILE"; then
      sed -i.bak -E "s|^$1=.*|$1=$2|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    else
      echo "$1=$2" >>"$ENV_FILE"
    fi
  }
  set_env NEXT_PUBLIC_DEMO_MARKET_ADDRESS "$DEMO_MARKET"
  set_env NEXT_PUBLIC_DEMO_ROUTER_ADDRESS "$DEMO_ROUTER"
  set_env NEXT_PUBLIC_DEMO_FEED_ADDRESS "$DEMO_FEED"
fi

cat <<SUMMARY

  $(printf '\033[1;32m✓ demo market deployed to %s\033[0m' "$NETWORK")

  DemoPriceFeed         $DEMO_FEED
  Demo ParimutuelRound  $DEMO_MARKET
  Demo router           $DEMO_ROUTER

  The frontend bakes these in at build time, so the running image does not
  have them yet:

    NEXT_PUBLIC_DEMO_MARKET_ADDRESS=$DEMO_MARKET
    NEXT_PUBLIC_DEMO_ROUTER_ADDRESS=$DEMO_ROUTER

  Prove it end to end before anyone watches:

    MARKET=demo NETWORK=$NETWORK ./scripts/live-e2e.sh

  The indexer is untouched and still covers the primary market only —
  the demo market's rounds will not appear in the API (GHO-34).

SUMMARY
