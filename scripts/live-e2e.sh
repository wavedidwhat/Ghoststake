#!/usr/bin/env bash
#
# Drives the whole user journey as real transactions against a deployed chain.
#
#   ./scripts/live-e2e.sh                 # local anvil, jumps time, full cycle
#   NETWORK=ethereum-sepolia ./scripts/live-e2e.sh
#
# Reads addresses from ghoststake-frontend/.env.local, which the deploy scripts
# write — so this always tests the deployment that is actually configured
# rather than one passed in by hand and possibly stale.
#
# On anvil, time is advanced with evm_increaseTime so the lock and close
# arrive immediately. On a public chain it waits on the wall clock, and the
# resolve additionally needs the price feed to have published after the close;
# that cadence, not this script, sets how long a round takes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="${NETWORK:-local}"

case "$NETWORK" in
  local)            RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"; CAN_WARP=1; LEAD=30 ;;
  ethereum-sepolia) RPC_URL="${RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"; CAN_WARP=0; LEAD=240 ;;
  robinhood-testnet) RPC_URL="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"; CAN_WARP=0; LEAD=240 ;;
  *) echo "unknown NETWORK '$NETWORK'" >&2; exit 1 ;;
esac

export ARBISCAN_API_KEY="${ARBISCAN_API_KEY:-}"
log()  { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
pass() { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }

ENV_FILE="$ROOT/ghoststake-frontend/.env.local"
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE — run a deploy script first" >&2; exit 1; }

get() { grep -E "^$1=" "$ENV_FILE" | cut -d= -f2; }
export VAULT_ADDRESS="$(get NEXT_PUBLIC_VAULT_ADDRESS)"
export MARKET_ADDRESS="$(get NEXT_PUBLIC_MARKET_ADDRESS)"
export ROUTER_ADDRESS="$(get NEXT_PUBLIC_ROUTER_ADDRESS)"

if [ -z "$MARKET_ADDRESS" ] || [ -z "$ROUTER_ADDRESS" ]; then
  echo "the configured deployment has no market or router — redeploy first" >&2
  exit 1
fi

cd "$ROOT/ghoststake-contracts"
export ASSET_ADDRESS="$(cast call "$VAULT_ADDRESS" 'asset()(address)' --rpc-url "$RPC_URL")"

if [ "$NETWORK" = "local" ]; then
  # anvil account 0, forced rather than defaulted: .env may hold a testnet key
  # with no gas here.
  export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  export E2E_OPPONENT_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
else
  set -a && . ./.env && set +a
fi

# Gas headroom: the script is simulated against pre-broadcast state, so
# estimates for later transactions do not account for storage the earlier ones
# write. A borrow after a supply ran out of gas on Sepolia for exactly this.
run() {
  forge script "script/LiveE2E.s.sol:LiveE2E" --sig "$1" --rpc-url "$RPC_URL" \
    --broadcast --slow --gas-estimate-multiplier 250 2>&1
}

warp() {
  if [ "$CAN_WARP" = "1" ]; then
    cast rpc evm_increaseTime "$1" --rpc-url "$RPC_URL" >/dev/null
    cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
  else
    log "waiting ${1}s for the chain clock"
    sleep "$1"
  fi
}

log "network $NETWORK — vault $VAULT_ADDRESS"

# ---- open ------------------------------------------------------------------
# Mine once so the chain's clock is current before anything reads it. anvil
# only mines on demand, so an idle chain reports a stale timestamp and every
# schedule derived from it lands in the past.
[ "$CAN_WARP" = "1" ] && cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null

log "depositing collateral and delegating"
OUT="$(run 'preparePhase()')" || { echo "$OUT" >&2; exit 1; }
echo "$OUT" | grep -E '^\s+(collateral|delegated)' || true
pass "collateral in, router delegated"

# Wall clock plus a lead, rather than the chain's last block. See LiveE2E.
# The lead only has to outlive one transaction now that opening is its own
# phase — on a public chain the deposit sequence alone ate a 90s lead.
export E2E_OPEN_TIME=$(( $(date +%s) + LEAD ))

export E2E_ENTRY_WINDOW="${E2E_ENTRY_WINDOW:-$(( LEAD + 120 ))}"
export E2E_OBSERVATION="${E2E_OBSERVATION:-120}"

log "opening a round"
OUT="$(run 'openPhase()')" || { echo "$OUT" >&2; exit 1; }
ROUND="$(echo "$OUT" | grep -E '^\s+round\s' | awk '{print $2}')"
CLOSE_AT="$(echo "$OUT" | grep -E '^\s+closes\s' | awk '{print $2}')"
[ -n "$ROUND" ] || { echo "$OUT" >&2; echo "could not parse the round id" >&2; exit 1; }
export E2E_ROUND="$ROUND"
pass "round $ROUND open"

# Entry does not begin until openTime.
warp $(( LEAD + 15 ))

# ---- stake -----------------------------------------------------------------
log "borrowing into a position through the router"
OUT="$(run 'stakePhase()')" || { echo "$OUT" >&2; exit 1; }
echo "$OUT" | grep -E '^\s+(staked|debt|wallet out)' || true
pass "borrowed funds reached the round without touching the wallet"

# The opposing side needs a *different* funded account. Reusing the deployer
# does not work and is not a limitation of this script: it staked through the
# router, which set a settlement sink, and the round refuses a second entry
# from the same user without one. That is `MixedFunding`, and it is the
# behaviour GHO-15 pinned with a test.
if [ -n "${E2E_OPPONENT_KEY:-}" ]; then
  log "taking the opposing side"
  run 'opposePhase()' >/dev/null || { echo "opposing stake failed" >&2; exit 1; }
  pass "both sides funded"
else
  log "no E2E_OPPONENT_KEY — one side only, so this round will void at lock"
  VOID_EXPECTED=1
fi

# ---- lock ------------------------------------------------------------------
NOW="$(cast block latest --rpc-url "$RPC_URL" -f timestamp)"
LOCK_AT="$(cast call "$MARKET_ADDRESS" 'rounds(uint256)' "$ROUND" --rpc-url "$RPC_URL" >/dev/null 2>&1 && echo "" || echo "")"
warp 130

log "locking the round"
OUT="$(run 'lockPhase()')" || { echo "$OUT" >&2; exit 1; }
echo "$OUT" | grep -E '^\s+(strike|phase|voided)' || true

if [ "${VOID_EXPECTED:-0}" = "1" ]; then
  pass "round voided at lock, as a one-sided round must"
  log "claiming the refund — settlement still runs, and still repays the debt"
  OUT="$(run 'settlePhase()')" || { echo "$OUT" >&2; exit 1; }
  echo "$OUT" | grep -E '^\s+(claimed|repaid|returned|no payout)' || true
  pass "refund settled through the router"
  echo ""
  printf '\033[1;32m  ✓ open, borrow, stake, void and refund verified live on %s\033[0m\n' "$NETWORK"
  exit 0
fi
pass "strike captured"

# ---- settle ----------------------------------------------------------------
warp 130

FEED="$(cast call "$(cast call "$MARKET_ADDRESS" 'oracle()(address)' --rpc-url "$RPC_URL")" 'feed()(address)' --rpc-url "$RPC_URL" 2>/dev/null || echo "")"

if [ "$CAN_WARP" = "1" ] && [ -n "$FEED" ]; then
  # Two rounds, straddling the close — not one after it.
  #
  # Pinning accepts a feed round only if it is the last published at or before
  # closeTime, which it proves by checking that the *next* round lands after.
  # A single post-close price satisfies neither half and the adapter reports
  # the price as unavailable, which is what a first attempt here did.
  log "publishing feed rounds either side of the close"
  cast send "$FEED" 'push(int256,uint256)' 2100e8 "$(( CLOSE_AT - 1 ))" \
    --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" >/dev/null
  export E2E_CLOSE_ROUND="$(cast call "$FEED" 'latestRoundId()(uint80)' --rpc-url "$RPC_URL")"

  cast send "$FEED" 'push(int256,uint256)' 2150e8 "$(( CLOSE_AT + 30 ))" \
    --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" >/dev/null
  log "settling against feed round $E2E_CLOSE_ROUND (the last at or before the close)"
else
  log "finding the feed round that closes this one"
  export E2E_CLOSE_ROUND="${E2E_CLOSE_ROUND:-0}"
  if [ "$E2E_CLOSE_ROUND" = "0" ]; then
    echo ""
    echo "  A real price feed cannot be pushed. This round resolves only once the"
    echo "  feed publishes after ${CLOSE_AT}. Re-run the settle step with:"
    echo ""
    echo "    E2E_ROUND=$ROUND E2E_CLOSE_ROUND=<feed round> \\"
    echo "      forge script script/LiveE2E.s.sol:LiveE2E --sig 'settlePhase()' \\"
    echo "      --rpc-url $RPC_URL --broadcast"
    echo ""
    pass "open, borrow, stake and lock all verified live"
    exit 0
  fi
fi

log "resolving and claiming"
OUT="$(run 'settlePhase()')" || { echo "$OUT" >&2; exit 1; }
echo "$OUT" | grep -E '^\s+(close|winner|claimed|repaid|returned|no payout)' || true
pass "settled, debt repaid from the payout, surplus returned"

echo ""
printf '\033[1;32m  ✓ full lifecycle verified live on %s\033[0m\n' "$NETWORK"
