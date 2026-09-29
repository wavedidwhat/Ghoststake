#!/usr/bin/env bash
#
# Keeps the demo market filmable (GHO-123).
#
#   ./scripts/demo-market.sh wallets          # make the three demo wallets, show what to fund
#   ./scripts/demo-market.sh setup            # one-time: hand the price feed to the price bot, mint and approve
#   ./scripts/demo-market.sh run              # while filming: fresh prices, both sides seeded, winnings claimed
#   ./scripts/demo-market.sh run --outcome yes   # ...and steer each round that's waiting on its result to Yes
#   ./scripts/demo-market.sh status           # price, current round, pools
#   ./scripts/demo-market.sh push 2150        # publish one price by hand
#   ./scripts/demo-market.sh release          # hand the price feed back to the deployer
#
# The keeper runs the rounds (open, lock, settle), exactly as it does for the
# real market. It refuses to open one while the feed has no usable price,
# which is why the demo market sat idle: nobody had published into it for
# days. This script is the other half: it keeps the price moving, and puts
# money on both sides of each round so a round settles with a winner rather
# than voiding for being one-sided.
#
# Three wallets, each doing one job, because the keeper and the price mirror
# already send from the deployer wallet. A third sender on that key would
# race them for nonces and drop transactions at random.
#
#   PRICER    owns the demo price feed (setup moves it there) and publishes
#   PLAYER_A  backs Yes on each round
#   PLAYER_B  backs No on each round
#
# Keys live in ghoststake-contracts/.env.demo, which git ignores. Addresses are
# printed; keys never are.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"

RPC_URL="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
FRONTEND_ENV="$ROOT/ghoststake-frontend/.env.local"
CONTRACTS_ENV="$ROOT/ghoststake-contracts/.env"
DEMO_ENV="${DEMO_ENV:-$ROOT/ghoststake-contracts/.env.demo}"

# How often the loop runs. The keeper polls every 10s and a demo round is
# 2.5 minutes of entry and 2.5 of observation, so 15s gives about ten prices
# per observation window: enough to steer, not so many the chart is noise.
TICK="${TICK:-15}"
# Each player puts in a random amount in this range, in whole mUSDC, so the
# odds on screen differ from round to round. The market's minimum per side
# is 10.
SEED_MIN="${SEED_MIN:-12}"
SEED_MAX="${SEED_MAX:-45}"

log()  { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m  ✗\033[0m %s\n' "$*" >&2; exit 1; }

# One key from a KEY=value file, tolerating it being absent. `tail -1`
# because deploy scripts have written some keys twice; the last one is meant.
get() { grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

[ -f "$FRONTEND_ENV" ] || die "no $FRONTEND_ENV: it holds the deployed addresses"
command -v cast >/dev/null || die "cast not found: install Foundry (foundryup)"

MARKET="$(get "$FRONTEND_ENV" NEXT_PUBLIC_DEMO_MARKET_ADDRESS)"
FEED="$(get "$FRONTEND_ENV" NEXT_PUBLIC_DEMO_FEED_ADDRESS)"
[ -n "$MARKET" ] && [ -n "$FEED" ] || die "no demo market or feed in $FRONTEND_ENV"

call() { cast call "$@" --rpc-url "$RPC_URL" 2>/dev/null | awk '{print $1}'; }

# Sends from one wallet and waits for the receipt. Returns non-zero on any
# failure so the loop can report it and carry on, rather than dying mid-film.
send() {
  local key="$1"; shift
  cast send "$@" --private-key "$key" --rpc-url "$RPC_URL" >/dev/null 2>/tmp/demo-market-send.err \
    || { warn "$(head -c 240 /tmp/demo-market-send.err | tr '\n' ' ')"; return 1; }
}

load_wallets() {
  [ -f "$DEMO_ENV" ] || die "no $DEMO_ENV: run '$0 wallets' first"
  PRICER_KEY="$(get "$DEMO_ENV" PRICER_KEY)"
  PLAYER_A_KEY="$(get "$DEMO_ENV" PLAYER_A_KEY)"
  PLAYER_B_KEY="$(get "$DEMO_ENV" PLAYER_B_KEY)"
  PRICER="$(cast wallet address --private-key "$PRICER_KEY")"
  PLAYER_A="$(cast wallet address --private-key "$PLAYER_A_KEY")"
  PLAYER_B="$(cast wallet address --private-key "$PLAYER_B_KEY")"
  ASSET="$(call "$MARKET" 'stakeAsset()(address)')"
}

eth() { cast balance "$1" --rpc-url "$RPC_URL" --ether 2>/dev/null; }
musdc() { local raw; raw="$(call "$ASSET" 'balanceOf(address)(uint256)' "$1")"; echo "$(( ${raw:-0} / 1000000 ))"; }

# ---------------------------------------------------------------------------

# A fresh key. Parsed as JSON: cast prints it across several lines with
# spaces, which a one-line pattern silently fails to match.
new_key() { cast wallet new --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["private_key"])'; }

cmd_wallets() {
  if [ -f "$DEMO_ENV" ]; then
    log "demo wallets already exist in $DEMO_ENV"
  else
    log "creating three demo wallets in $DEMO_ENV"
    umask 077
    {
      echo "# Demo wallets for scripts/demo-market.sh (GHO-123). Testnet only. Never commit."
      echo "PRICER_KEY=$(new_key)"
      echo "PLAYER_A_KEY=$(new_key)"
      echo "PLAYER_B_KEY=$(new_key)"
    } >"$DEMO_ENV"
    ok "created (file mode 600, ignored by git)"
  fi
  load_wallets
  printf '\n  %-9s %s  %s ETH\n' "price bot" "$PRICER" "$(eth "$PRICER")"
  printf '  %-9s %s  %s ETH\n' "player A" "$PLAYER_A" "$(eth "$PLAYER_A")"
  printf '  %-9s %s  %s ETH\n\n' "player B" "$PLAYER_B" "$(eth "$PLAYER_B")"
  echo "  Each needs a little testnet ETH on Robinhood Chain (chain 46630) for gas."
  echo "  At 0.01 gwei, 0.002 ETH is thousands of transactions."
}

cmd_setup() {
  load_wallets
  local owner deployer_key
  owner="$(call "$FEED" 'owner()(address)')"
  if [ "$(echo "$owner" | tr A-F a-f)" = "$(echo "$PRICER" | tr A-F a-f)" ]; then
    ok "price bot already owns the demo feed"
  else
    log "handing the demo feed from $owner to the price bot"
    deployer_key="$(get "$CONTRACTS_ENV" PRIVATE_KEY)"
    [ -n "$deployer_key" ] || die "no PRIVATE_KEY in $CONTRACTS_ENV: the feed's current owner must sign this"
    send "$deployer_key" "$FEED" 'transferOwnership(address)' "$PRICER" || die "ownership transfer failed"
    ok "price bot now owns the feed ($0 release hands it back)"
  fi

  local who key
  for who in A B; do
    if [ "$who" = A ]; then key="$PLAYER_A_KEY"; else key="$PLAYER_B_KEY"; fi
    local addr; addr="$(cast wallet address --private-key "$key")"
    if [ "$(musdc "$addr")" -lt 1000 ]; then
      log "minting 10,000 mUSDC to player $who"
      send "$key" "$ASSET" 'mint(address,uint256)' "$addr" 10000000000 || die "mint failed for player $who"
    fi
    local allowance; allowance="$(call "$ASSET" 'allowance(address,address)(uint256)' "$addr" "$MARKET")"
    if [ "${#allowance}" -lt 20 ]; then
      log "player $who approves the demo market"
      send "$key" "$ASSET" 'approve(address,uint256)' "$MARKET" "$(cast max-uint)" || die "approve failed for player $who"
    fi
    ok "player $who ready: $(musdc "$addr") mUSDC"
  done
}

# The feed price in its own units (8 decimals).
feed_price() { cast call "$FEED" 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RPC_URL" 2>/dev/null | sed -n 2p | awk '{print $1}'; }
feed_age()   { local at; at="$(cast call "$FEED" 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$RPC_URL" 2>/dev/null | sed -n 4p | awk '{print $1}')"; echo $(( $(date +%s) - ${at:-0} )); }

# One field of rounds(id), by position in the Round struct.
round_field() {
  cast call "$MARKET" 'rounds(uint256)((uint64,uint64,uint64,uint8,uint8,uint256,uint256,uint80,uint256,uint256,uint256))' "$1" \
    --rpc-url "$RPC_URL" 2>/dev/null | tr -d '()' | tr ',' '\n' | sed -n "${2}p" | awk '{print $1}'
}
PHASES=(none open "entry closed" observing settled voided)

cmd_push() {
  load_wallets
  local price="${1:?usage: push <price in dollars, e.g. 2150 or 2150.25>}"
  local units; units="$(python3 -c "print(round(float('$price') * 10**8))")"
  send "$PRICER_KEY" "$FEED" 'push(int256)' "$units" && ok "published \$$price"
}

cmd_status() {
  load_wallets
  local price age n
  price="$(feed_price)"; age="$(feed_age)"
  printf '  price    $%s (published %ss ago)\n' "$(python3 -c "print(f'{${price:-0}/1e8:,.2f}')")" "$age"
  n="$(call "$MARKET" 'roundCount()(uint256)')"
  if [ "${n:-0}" = "0" ]; then echo "  rounds   none yet"; return; fi
  local id
  for id in $(seq "$n" -1 $(( n > 2 ? n - 2 : 1 ))); do
    local phase up down strike
    phase="$(call "$MARKET" 'phaseOf(uint256)(uint8)' "$id")"
    up="$(call "$MARKET" 'poolOf(uint256,uint8)(uint256)' "$id" 0)"
    down="$(call "$MARKET" 'poolOf(uint256,uint8)(uint256)' "$id" 1)"
    strike="$(round_field "$id" 6)"
    printf '  round %-3s %-13s strike $%s   yes %s · no %s mUSDC\n' "$id" "${PHASES[${phase:-0}]}" \
      "$(python3 -c "print(f'{${strike:-0}/1e18:,.2f}')")" "$(( ${up:-0} / 1000000 ))" "$(( ${down:-0} / 1000000 ))"
  done
  printf '  wallets  bot %s ETH · A %s ETH, %s mUSDC · B %s ETH, %s mUSDC\n' \
    "$(eth "$PRICER")" "$(eth "$PLAYER_A")" "$(musdc "$PLAYER_A")" "$(eth "$PLAYER_B")" "$(musdc "$PLAYER_B")"
}

cmd_release() {
  load_wallets
  local deployer; deployer="$(get "$CONTRACTS_ENV" DEPLOYER_ADDRESS)"
  [ -n "$deployer" ] || die "no DEPLOYER_ADDRESS in $CONTRACTS_ENV"
  send "$PRICER_KEY" "$FEED" 'transferOwnership(address)' "$deployer" && ok "demo feed handed back to $deployer"
}

# The next price. A small random walk; while a round is observing and an
# outcome is set, it walks toward just past that round's strike instead, so
# the round closes on the chosen side. It never jumps: a demo that teleports
# the price is a demo nobody believes.
next_price() {
  local price="$1" target="$2"
  local noise=$(( (RANDOM % 41) - 20 ))            # ±0.20% in basis points / 10
  local step=$(( price * noise / 10000 ))
  if [ -n "$target" ]; then
    step=$(( (target - price) / 3 + step / 3 ))
  fi
  echo $(( price + step ))
}

cmd_run() {
  local outcome=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --outcome) outcome="${2:-}"; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  case "$outcome" in ""|yes|no) ;; *) die "--outcome is yes or no" ;; esac
  load_wallets

  local owner; owner="$(call "$FEED" 'owner()(address)')"
  [ "$(echo "$owner" | tr A-F a-f)" = "$(echo "$PRICER" | tr A-F a-f)" ] || die "the price bot doesn't own the demo feed: run '$0 setup'"

  # Players without gas can't seed or claim. Said once, here, rather than as
  # a failure every tick; the price still runs, which keeps the keeper going.
  local seeding=1
  if [ "$(eth "$PLAYER_A")" = "0.000000000000000000" ] || [ "$(eth "$PLAYER_B")" = "0.000000000000000000" ]; then
    warn "players A and B need gas before they can seed rounds: running as a price bot only"
    warn "fund $PLAYER_A and $PLAYER_B, then '$0 setup', then run again"
    seeding=0
  fi

  log "running every ${TICK}s${outcome:+, steering results to $outcome}. Ctrl-C to stop."
  local price; price="$(feed_price)"; price="${price:-200000000000}"
  local seeded=" " claimed=" "

  while true; do
    local n target="" id phase
    n="$(call "$MARKET" 'roundCount()(uint256)')"; n="${n:-0}"

    # Steer the round that's waiting on its result, if asked to.
    if [ -n "$outcome" ] && [ "$n" -gt 0 ]; then
      for id in "$n" $(( n - 1 )); do
        [ "$id" -ge 1 ] || continue
        phase="$(call "$MARKET" 'phaseOf(uint256)(uint8)' "$id")"
        if [ "$phase" = "3" ]; then
          # 18-decimal strike to the feed's 8. Through Python: a WAD price
          # (~2e21) is past bash's 64-bit integers, which would wrap silently.
          local strike8; strike8="$(python3 -c "print(int('$(round_field "$id" 6)') // 10**10)")"
          if [ "$outcome" = yes ]; then target=$(( strike8 * 10030 / 10000 )); else target=$(( strike8 * 9970 / 10000 )); fi
          break
        fi
      done
    fi

    price="$(next_price "$price" "$target")"
    if send "$PRICER_KEY" "$FEED" 'push(int256)' "$price"; then
      printf '  %s  $%s%s\n' "$(date +%H:%M:%S)" "$(python3 -c "print(f'{$price/1e8:,.2f}')")" "${target:+  (steering round to $outcome)}"
    fi

    # Seed both sides of any round still taking entries.
    [ "$seeding" = 1 ] && for id in "$n" $(( n - 1 )); do
      [ "$id" -ge 1 ] || continue
      case "$seeded" in *" $id "*) continue ;; esac
      [ "$(call "$MARKET" 'entryIsOpen(uint256)(bool)' "$id")" = "true" ] || continue
      local a b
      a=$(( SEED_MIN + RANDOM % (SEED_MAX - SEED_MIN + 1) ))
      b=$(( SEED_MIN + RANDOM % (SEED_MAX - SEED_MIN + 1) ))
      send "$PLAYER_A_KEY" "$MARKET" 'takePosition(uint256,uint8,uint256)' "$id" 0 "$(( a * 1000000 ))" \
        && send "$PLAYER_B_KEY" "$MARKET" 'takePosition(uint256,uint8,uint256)' "$id" 1 "$(( b * 1000000 ))" \
        && { seeded="$seeded$id "; ok "round $id seeded: $a on Yes, $b on No"; }
    done

    # Collect anything the players won, so their balances don't just pile up
    # in the contract.
    [ "$seeding" = 1 ] && [ "$n" -ge 1 ] && for id in $(seq $(( n > 4 ? n - 4 : 1 )) "$n"); do
      case "$claimed" in *" $id "*) continue ;; esac
      phase="$(call "$MARKET" 'phaseOf(uint256)(uint8)' "$id")"
      [ "$phase" = "4" ] || [ "$phase" = "5" ] || continue
      local who
      for who in A B; do
        local key addr owed
        if [ "$who" = A ]; then key="$PLAYER_A_KEY"; addr="$PLAYER_A"; else key="$PLAYER_B_KEY"; addr="$PLAYER_B"; fi
        owed="$(call "$MARKET" 'claimableOf(uint256,address)(uint256)' "$id" "$addr")"
        if [ "${owed:-0}" != "0" ]; then
          send "$key" "$MARKET" 'claim(uint256,address)' "$id" "$addr" && ok "player $who claimed $(( owed / 1000000 )) mUSDC from round $id"
        fi
      done
      claimed="$claimed$id "
    done

    sleep "$TICK"
  done
}

case "${1:-}" in
  wallets) cmd_wallets ;;
  setup)   cmd_setup ;;
  run)     shift; cmd_run "$@" ;;
  status)  cmd_status ;;
  push)    shift; cmd_push "$@" ;;
  release) cmd_release ;;
  *) sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
