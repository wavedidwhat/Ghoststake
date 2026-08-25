#!/usr/bin/env bash
#
# Drives the whole user journey as real transactions against a deployed chain.
#
#   ./scripts/live-e2e.sh                 # local anvil, jumps time, full cycle
#   NETWORK=ethereum-sepolia ./scripts/live-e2e.sh
#   MARKET=demo NETWORK=ethereum-sepolia ./scripts/live-e2e.sh
#
# Reads addresses from ghoststake-frontend/.env.local, which the deploy scripts
# write — so this always tests the deployment that is actually configured
# rather than one passed in by hand and possibly stale.
#
# On anvil, time is advanced with evm_increaseTime so the lock and close
# arrive immediately. On a public chain it waits on the wall clock, and the
# resolve additionally needs the price feed to have published after the close;
# that cadence, not this script, sets how long a round takes.
#
# MARKET=demo runs against the demo market (GHO-29), whose feed the deployer
# publishes into by hand. That is the only way to get a full settlement out of
# a public chain in one run: on the real feed this script gets as far as the
# lock and then tells you to come back when the heartbeat has fired.
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

# Reads one key, and tolerates it being absent.
#
# The `|| true` is load-bearing under `set -o pipefail`: a key that is not in
# the file makes `grep` exit non-zero, which fails the command substitution,
# which kills the script at the assignment — with no output, because the
# output is what was being captured. That has now cost three debugging
# sessions in two days, so it is fixed in the helper rather than at each call.
#
# `tail -1` because the deploy scripts have historically written a key twice;
# the last one is the one they meant.
get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2 || true; }
export VAULT_ADDRESS="$(get NEXT_PUBLIC_VAULT_ADDRESS)"

if [ "${MARKET:-primary}" = "demo" ]; then
  export MARKET_ADDRESS="$(get NEXT_PUBLIC_DEMO_MARKET_ADDRESS)"
  export ROUTER_ADDRESS="$(get NEXT_PUBLIC_DEMO_ROUTER_ADDRESS)"
  if [ -z "$MARKET_ADDRESS" ]; then
    echo "no demo market in $ENV_FILE — redeploy with DEMO_MARKET=true" >&2
    exit 1
  fi
else
  export MARKET_ADDRESS="$(get NEXT_PUBLIC_MARKET_ADDRESS)"
  export ROUTER_ADDRESS="$(get NEXT_PUBLIC_ROUTER_ADDRESS)"
fi

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

# Advance to a deadline the round actually holds, rather than by a fixed
# number of seconds.
#
# The fixed jumps this replaces were tuned to the schedule and then drifted
# from it: the round is scheduled against the wall clock plus a lead, the
# chain's clock is its own thing, and the sum of the hops came out five
# seconds short of the lock. That fails as `TooEarly`, which reads like a
# contract bug and is not one.
warp_until() {
  local target="$1" now delta
  now="$(cast block latest --rpc-url "$RPC_URL" -f timestamp)"
  delta=$(( target - now + 2 ))
  if [ "$delta" -gt 0 ]; then
    warp "$delta"
  fi
}

log "network $NETWORK — vault $VAULT_ADDRESS — market $MARKET_ADDRESS"

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
# Whichever clock is further ahead, plus the lead. Wall clock alone is right
# on a public chain and wrong on anvil after a warp — a previous run that
# jumped the chain five minutes forward leaves every wall-clock schedule in
# the chain's past, and `openRound` rejects it as "open time is already behind
# the chain".
CHAIN_NOW="$(cast block latest --rpc-url "$RPC_URL" -f timestamp)"
WALL_NOW="$(date +%s)"
BASE_NOW=$(( CHAIN_NOW > WALL_NOW ? CHAIN_NOW : WALL_NOW ))
export E2E_OPEN_TIME=$(( BASE_NOW + LEAD ))

export E2E_ENTRY_WINDOW="${E2E_ENTRY_WINDOW:-$(( LEAD + 120 ))}"
export E2E_OBSERVATION="${E2E_OBSERVATION:-120}"

log "opening a round"
OUT="$(run 'openPhase()')" || { echo "$OUT" >&2; exit 1; }
ROUND="$(echo "$OUT" | grep -E '^\s+round\s' | awk '{print $2}')"
OPEN_AT="$(echo "$OUT" | grep -E '^\s+opens\s' | awk '{print $2}')"
LOCK_AT="$(echo "$OUT" | grep -E '^\s+locks\s' | awk '{print $2}')"
CLOSE_AT="$(echo "$OUT" | grep -E '^\s+closes\s' | awk '{print $2}')"
[ -n "$ROUND" ] || { echo "$OUT" >&2; echo "could not parse the round id" >&2; exit 1; }
export E2E_ROUND="$ROUND"
pass "round $ROUND open"

# Entry does not begin until openTime.
warp_until "$OPEN_AT"

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
warp_until "$LOCK_AT"

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
warp_until "$CLOSE_AT"

FEED="$(cast call "$(cast call "$MARKET_ADDRESS" 'oracle()(address)' --rpc-url "$RPC_URL")" 'feed()(address)' --rpc-url "$RPC_URL" 2>/dev/null || echo "")"

# Whether this feed will take a price from us, asked of the feed itself rather
# than inferred from the network. A DemoPriceFeed says so in `description()`
# precisely so that both a UI and a script can tell the two kinds apart — and
# so nobody has to keep a list of which addresses are pushable.
PUSHABLE=0
if [ -n "$FEED" ]; then
  FEED_DESC="$(cast call "$FEED" 'description()(string)' --rpc-url "$RPC_URL" 2>/dev/null || echo "")"
  case "$FEED_DESC" in *"GHOSTSTAKE DEMO FEED"*) PUSHABLE=1 ;; esac
  log "feed $FEED ${FEED_DESC:-(no description)}"
fi

if [ "$PUSHABLE" = "1" ]; then
  # Two rounds, straddling the close — not one after it.
  #
  # Pinning accepts a feed round only if it is the last published at or before
  # closeTime, which it proves by checking that the *next* round lands after.
  # A single post-close price satisfies neither half and the adapter reports
  # the price as unavailable, which is what a first attempt here did.
  log "publishing feed rounds either side of the close"
  cast send "$FEED" 'pushAt(int256,uint256)' 2100e8 "$(( CLOSE_AT - 1 ))" \
    --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" >/dev/null
  export E2E_CLOSE_ROUND="$(cast call "$FEED" 'latestRoundId()(uint80)' --rpc-url "$RPC_URL")"

  cast send "$FEED" 'pushAt(int256,uint256)' 2150e8 "$(( CLOSE_AT + 30 ))" \
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
