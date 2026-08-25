"use client";

import { useState } from "react";
import { useConnection, usePublicClient, useReadContract } from "wagmi";
import { TxStatus } from "@/components/AmountField";
import { AppShell, NeedsWallet, NotConfigured } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { useMarketFeeds, type MarketFeed } from "@/hooks/useMarketFeeds";
import { useMarkets } from "@/hooks/useMarkets";
import { useNow } from "@/hooks/useNow";
import { useMarketParams, useRounds, type MarketParams, type MarketRound } from "@/hooks/useRounds";
import { useTransaction } from "@/hooks/useTransaction";
import {
  aggregatorV3InterfaceAbi,
  chainlinkRoundOracleAbi,
  demoPriceFeedAbi,
  parimutuelRoundAbi,
} from "@/lib/abis";
import { formatAmount } from "@/lib/format";
import { anyMarketConfigured, type Market } from "@/lib/markets";
import {
  Action,
  actionFor,
  findCloseRound,
  isOwnerOnly,
  scheduleFrom,
  scheduleProblem,
  warningsFor,
  type ActionValue,
} from "@/lib/operator";
import { Phase, Status, formatCountdown, phaseLabel, type PhaseValue } from "@/lib/rounds";
import { activeChain } from "@/lib/wagmi";
import { useVaultPosition } from "@/hooks/useVaultPosition";

/**
 * The operator console.
 *
 * Everything the protocol needs a human to do, in one place, with the
 * consequences stated before the button rather than after it. Before this the
 * only way to run a round was a forge script, and that cost a real one:
 * GHO-18's round 2 on Sepolia held 5,000 mUSDC a side, nobody called
 * `lockRound` inside the 60-second window, and it voided. Nothing was lost —
 * everyone was refunded — but the round meant to demonstrate a settlement
 * never produced one.
 *
 * # This page is not owner-only, and says so
 *
 * `lockRound`, `resolveRound` and `voidUnlockedRound` are permissionless by
 * design: a round's liveness must not depend on one key being awake. Hiding
 * them behind an owner check would misrepresent the protocol to the person
 * most likely to be reading. Only `openRound` and `voidUnsettledRound` are
 * owner-gated, and those say whose key is needed.
 */
export default function OperatorPage() {
  const connection = useConnection();

  return (
    <AppShell title="Operator" subtitle="Drive rounds — open, lock, settle, unwind">
      {!anyMarketConfigured() ? (
        <NotConfigured what="No market is configured for this network." />
      ) : connection.status !== "connected" ? (
        <NeedsWallet what="Every action here is a transaction, so a wallet is needed to send one." />
      ) : (
        <Console address={connection.address} />
      )}
    </AppShell>
  );
}

function Console({ address }: { address: `0x${string}` }) {
  const now = useNow();
  // Every market, including delisted ones. An operator's job includes the
  // markets nobody is browsing — a delisted market with a locked round still
  // has to be settled or refunded, and hiding it here would strand it.
  const { markets, isLoading: marketsLoading } = useMarkets();
  const params = useMarketParams(markets);
  const feeds = useMarketFeeds(markets);
  const { rounds, isLoading, isError, refetch } = useRounds(markets);
  const position = useVaultPosition();

  if (isError) {
    return (
      <Card>
        <p className="text-sm text-ink-muted">
          The chain is unreachable right now. Nothing has changed — this screen just cannot see
          it.
        </p>
      </Card>
    );
  }

  if (marketsLoading || isLoading || params.byMarket.size === 0) {
    return (
      <Card>
        <div className="h-24 animate-pulse rounded bg-raised" />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      {markets.map((market: Market) => {
        const marketParams = params.byMarket.get(market.key);
        if (!marketParams) return null;
        return (
          <MarketConsole
            key={market.key}
            market={market}
            params={marketParams}
            feed={feeds.byMarket.get(market.key)}
            rounds={rounds.filter((r) => r.market.key === market.key)}
            address={address}
            now={now}
            decimals={position.decimals}
            symbol={position.symbol}
            refetch={refetch}
          />
        );
      })}
    </div>
  );
}

function MarketConsole({
  market,
  params,
  feed,
  rounds,
  address,
  now,
  decimals,
  symbol,
  refetch,
}: {
  market: Market;
  params: MarketParams;
  feed: MarketFeed | undefined;
  rounds: MarketRound[];
  address: `0x${string}`;
  now: bigint | undefined;
  decimals: number | undefined;
  symbol: string;
  refetch: () => void;
}) {
  const isOwner = address.toLowerCase() === params.owner.toLowerCase();
  const label = feed ? (feed.description.split(" - ").pop() ?? "Market") : "Reading feed…";

  // Newest first, and only the ones still in play — a settled round needs no
  // operator and a list of them buries the two that do.
  const live = rounds.filter((r) => r.phase !== Phase.Resolved && r.phase !== Phase.Void);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold text-ink">{label}</h2>
        {feed?.isDemo && (
          <span className="rounded-full bg-warning/15 px-2.5 py-0.5 text-xs font-semibold tracking-wide text-warning uppercase">
            Demo feed
          </span>
        )}
        <span className="text-xs text-ink-faint">
          {isOwner ? (
            <span className="text-positive">You are the owner of this market.</span>
          ) : (
            <>
              Owner is <code className="text-ink-muted">{short(params.owner)}</code> — you can
              still lock, resolve and unwind.
            </>
          )}
        </span>
      </div>

      {feed?.isDemo && <DemoFeedControl market={market} address={address} />}

      <OpenRoundForm market={market} params={params} isOwner={isOwner} now={now} onDone={refetch} />

      {live.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">
            No round is in play on this market. Open one above.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {live.map((r) => (
            <RoundRow
              key={`${market.key}-${r.id}`}
              market={market}
              round={r}
              params={params}
              isOwner={isOwner}
              now={now}
              decimals={decimals}
              symbol={symbol}
              onDone={refetch}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Open a round from the three windows an operator thinks in, with the
 * resulting times shown before the button.
 *
 * The lead is the part that is easy to get wrong and expensive to get wrong:
 * `openRound` rejects a start already in the past, and the gap between
 * signing and mining eats a short one. It defaults to a minute rather than to
 * nothing.
 */
function OpenRoundForm({
  market,
  params,
  isOwner,
  now,
  onDone,
}: {
  market: Market;
  params: MarketParams;
  isOwner: boolean;
  now: bigint | undefined;
  onDone: () => void;
}) {
  const [lead, setLead] = useState("60");
  const [entry, setEntry] = useState("300");
  const [observation, setObservation] = useState("300");
  const tx = useTransaction();

  const seconds = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? BigInt(Math.floor(parsed)) : null;
  };

  const leadSeconds = seconds(lead);
  const entryWindow = seconds(entry);
  const observationWindow = seconds(observation);
  const inputsValid =
    leadSeconds !== null && entryWindow !== null && observationWindow !== null && now !== undefined;

  const schedule = inputsValid
    ? scheduleFrom(now, leadSeconds, entryWindow, observationWindow)
    : null;
  const problem =
    schedule && now !== undefined ? scheduleProblem(schedule, params.entryCutoff, now) : null;

  const busy = tx.state.status === "signing" || tx.state.status === "pending";

  return (
    <Card>
      <h3 className="text-sm font-medium text-ink">Open a round</h3>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <SecondsField label="Lead" value={lead} onChange={setLead} disabled={busy}
          hint="Time before the round opens. Has to outlive signing and mining." />
        <SecondsField label="Entry window" value={entry} onChange={setEntry} disabled={busy}
          hint={`Open to locked. Entry actually stops ${params.entryCutoff}s before the lock.`} />
        <SecondsField label="Observation" value={observation} onChange={setObservation} disabled={busy}
          hint="Locked to close. The strike is measured against the price at the end of this." />
      </div>

      {schedule && (
        <dl className="mt-4 grid gap-2 rounded-lg border border-border bg-raised/40 p-3 text-xs sm:grid-cols-3">
          <Preview label="Opens" at={schedule.openTime} now={now} />
          <Preview label="Locks" at={schedule.lockTime} now={now} />
          <Preview label="Closes" at={schedule.closeTime} now={now} />
        </dl>
      )}

      {/* The feed's cadence, not ours, is the floor on a round's length —
          worth saying next to the observation window, where someone is about
          to choose one. */}
      <p className="mt-3 text-xs text-ink-faint">
        A round cannot settle until its feed publishes after the close. On a real feed that is a
        heartbeat measured in tens of minutes, whatever this window says.
      </p>

      {problem && <p className="mt-3 text-xs text-negative">{problem}</p>}

      {!isOwner && (
        <p className="mt-3 text-xs text-warning">
          Opening a round is owner-only. Connected as a different address, this will revert.
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          disabled={busy || !schedule || problem !== null || !isOwner}
          onClick={async () => {
            if (!schedule) return;
            const ok = await tx.send({
              address: market.address,
              abi: parimutuelRoundAbi,
              functionName: "openRound",
              args: [schedule.openTime, schedule.lockTime, schedule.closeTime],
            });
            if (ok) onDone();
          }}
          className="cursor-pointer rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ground transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Opening…" : "Open round"}
        </button>
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}

/** One round, what it needs, and what to know before doing it. */
function RoundRow({
  market,
  round,
  params,
  isOwner,
  now,
  decimals,
  symbol,
  onDone,
}: {
  market: Market;
  round: MarketRound;
  params: MarketParams;
  isOwner: boolean;
  now: bigint | undefined;
  decimals: number | undefined;
  symbol: string;
  onDone: () => void;
}) {
  const phase = (round.phase ?? Phase.None) as PhaseValue;
  const action = now === undefined ? Action.None : actionFor(round.round, phase, params, now);
  const warnings =
    now === undefined ? [] : warningsFor(round.round, phase, params, params.minSidePool, now);

  // The deadline that matters at this phase — the one the operator is racing.
  const deadline =
    phase === Phase.Observation
      ? round.round.closeTime + params.resolveDeadline
      : round.round.status === Status.Open
        ? round.round.lockTime + params.lockWindow
        : round.round.closeTime;
  const remaining = now === undefined ? undefined : deadline - now;

  return (
    <article className="rounded-card border border-border bg-surface p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-ink">Round {round.id.toString()}</span>
          <span className="rounded-full bg-raised px-2 py-0.5 text-xs text-ink-muted">
            {phaseLabel(phase)}
          </span>
          {decimals !== undefined && (
            <span className="tabular text-xs text-ink-faint">
              {formatAmount(round.round.upPool, decimals, 0)} up ·{" "}
              {formatAmount(round.round.downPool, decimals, 0)} down {symbol}
            </span>
          )}
        </div>
        {remaining !== undefined && (
          <span className="text-xs text-ink-faint">
            {deadlineLabel(action, phase)}{" "}
            <span className="tabular text-ink">{formatCountdown(remaining)}</span>
          </span>
        )}
      </header>

      {warnings.map((w) => (
        <p key={w.code} className="mt-3 text-xs text-warning">
          {w.text}
        </p>
      ))}

      {action === Action.Resolve ? (
        <ResolveControl
          market={market}
          roundId={round.id}
          closeTime={round.round.closeTime}
          lockOracleRoundId={round.round.lockOracleRoundId}
          onDone={onDone}
        />
      ) : action !== Action.None ? (
        <SimpleAction market={market} roundId={round.id} action={action} isOwner={isOwner} onDone={onDone} />
      ) : (
        <p className="mt-3 text-xs text-ink-muted">Nothing to do yet — waiting on the clock.</p>
      )}
    </article>
  );
}

function SimpleAction({
  market,
  roundId,
  action,
  isOwner,
  onDone,
}: {
  market: Market;
  roundId: bigint;
  action: ActionValue;
  isOwner: boolean;
  onDone: () => void;
}) {
  const tx = useTransaction();
  const busy = tx.state.status === "signing" || tx.state.status === "pending";
  const ownerOnly = isOwnerOnly(action);

  const fn =
    action === Action.Lock
      ? "lockRound"
      : action === Action.VoidUnlocked
        ? "voidUnlockedRound"
        : "voidUnsettledRound";

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button
        disabled={busy || (ownerOnly && !isOwner)}
        onClick={async () => {
          const ok = await tx.send({
            address: market.address,
            abi: parimutuelRoundAbi,
            functionName: fn,
            args: [roundId],
          });
          if (ok) onDone();
        }}
        className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-ground transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Working…" : actionLabel(action)}
      </button>
      <span className="text-xs text-ink-faint">
        {ownerOnly
          ? isOwner
            ? "Owner-only, and that is you."
            : "Owner-only. Connected as a different address, this will revert."
          : "Permissionless — anyone connected may call this."}
      </span>
      <TxStatus state={tx.state} />
    </div>
  );
}

/**
 * Resolve, once we know which feed round to name.
 *
 * The caller has to supply the feed round that closes the round, and the
 * adapter verifies the claim rather than taking it. So the console finds the
 * candidate by binary search, then *dry-runs* `readAt` against the adapter
 * before offering a button — because the search knows the feed's timestamps
 * and the adapter knows about staleness, sequencer uptime and pauses, and
 * only the adapter's answer decides whether the transaction lands.
 */
function ResolveControl({
  market,
  roundId,
  closeTime,
  lockOracleRoundId,
  onDone,
}: {
  market: Market;
  roundId: bigint;
  closeTime: bigint;
  lockOracleRoundId: bigint;
  onDone: () => void;
}) {
  const client = usePublicClient({ chainId: activeChain.id });
  const tx = useTransaction();
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<
    | { kind: "none"; reason: string }
    | { kind: "found"; feedRound: bigint; price: bigint }
    | { kind: "refused"; feedRound: bigint }
    | null
  >(null);

  const oracle = useReadContract({
    address: market.address,
    abi: parimutuelRoundAbi,
    functionName: "oracle",
    chainId: activeChain.id,
    query: { staleTime: Infinity },
  });

  const feed = useReadContract({
    address: oracle.data,
    abi: chainlinkRoundOracleAbi,
    functionName: "feed",
    chainId: activeChain.id,
    query: { enabled: Boolean(oracle.data), staleTime: Infinity },
  });

  async function search() {
    if (!client || !oracle.data || !feed.data) return;
    setSearching(true);
    setResult(null);
    try {
      const latestRoundId = (await client.readContract({
        address: feed.data,
        abi: aggregatorV3InterfaceAbi,
        functionName: "latestRoundData",
      })) as readonly [bigint, bigint, bigint, bigint, bigint];

      const candidate = await findCloseRound(
        async (id) => {
          try {
            const data = (await client.readContract({
              address: feed.data!,
              abi: aggregatorV3InterfaceAbi,
              functionName: "getRoundData",
              args: [id],
            })) as readonly [bigint, bigint, bigint, bigint, bigint];
            // An aggregator with no data at an id reverts rather than
            // returning zero, so the catch below is the normal path for a
            // gap — not an error to surface.
            return { updatedAt: data[3] };
          } catch {
            return null;
          }
        },
        latestRoundId[0],
        closeTime,
      );

      if (candidate === null) {
        setResult({
          kind: "none",
          reason:
            "The feed has not published since this round closed. Nothing can settle it yet — that is the pinning rule doing its job, not a fault.",
        });
        return;
      }

      // The adapter's own answer, not ours. It applies staleness, sequencer
      // uptime and the pause flag on top of the timestamps the search used.
      const [ok, price] = (await client.readContract({
        address: oracle.data,
        abi: chainlinkRoundOracleAbi,
        functionName: "readAt",
        args: [candidate, closeTime],
      })) as readonly [boolean, bigint];

      setResult(ok ? { kind: "found", feedRound: candidate, price } : { kind: "refused", feedRound: candidate });
    } catch {
      setResult({ kind: "none", reason: "The feed could not be read. Try again." });
    } finally {
      setSearching(false);
    }
  }

  const busy = tx.state.status === "signing" || tx.state.status === "pending";
  // The contract refuses a feed round older than the lock's own read, and
  // says so with `OracleRoundNotAdvanced`. Cheaper to catch here.
  const behindLock = result?.kind === "found" && result.feedRound < lockOracleRoundId;

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          disabled={searching || !feed.data}
          onClick={search}
          className="cursor-pointer rounded-lg border border-border-strong px-3 py-1.5 text-sm text-ink transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {searching ? "Searching the feed…" : "Find the closing feed round"}
        </button>
        <span className="text-xs text-ink-faint">
          Resolving names the feed round at the close. Permissionless — anyone may send it.
        </span>
      </div>

      {result?.kind === "none" && <p className="text-xs text-warning">{result.reason}</p>}

      {result?.kind === "refused" && (
        <p className="text-xs text-warning">
          Feed round {result.feedRound.toString()} is the last one before the close, but the
          adapter will not read it — stale, or the sequencer was down, or the feed is paused.
          Resolving now would revert.
        </p>
      )}

      {result?.kind === "found" && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-raised/40 p-3">
          <p className="text-xs text-ink-muted">
            Feed round <span className="tabular text-ink">{result.feedRound.toString()}</span>{" "}
            settles this at{" "}
            <span className="tabular text-ink">{formatAmount(result.price, 18, 2)}</span>. The
            adapter accepted it on a dry run, so the transaction will land.
          </p>
          {behindLock && (
            <p className="text-xs text-negative">
              That round predates the strike read, which the contract refuses. Something is wrong
              with the feed rather than with this round.
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              disabled={busy || behindLock}
              onClick={async () => {
                const ok = await tx.send({
                  address: market.address,
                  abi: parimutuelRoundAbi,
                  functionName: "resolveRound",
                  // A bigint, not a Number. Chainlink proxy round ids pack a
                  // phase into their high bits, so a real one is far past
                  // 2^53 and `Number` would round it to a neighbouring id
                  // that the adapter then refuses.
                  args: [roundId, result.feedRound],
                });
                if (ok) onDone();
              }}
              className="w-fit cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-ground transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Resolving…" : "Resolve"}
            </button>
            <TxStatus state={tx.state} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Publishing a price on a demo market's feed.
 *
 * Two pushes settle a round, not one, and the order is the whole thing: the
 * settlement price is the last round published *at or before* the close, and
 * the round after the close is what proves it was the last. A single push
 * after the close satisfies neither half — it is not the price at the close,
 * and it has no successor. That cost an hour the first time.
 */
function DemoFeedControl({ market, address }: { market: Market; address: `0x${string}` }) {
  const [price, setPrice] = useState("2000");
  const tx = useTransaction();

  const oracle = useReadContract({
    address: market.address,
    abi: parimutuelRoundAbi,
    functionName: "oracle",
    chainId: activeChain.id,
    query: { staleTime: Infinity },
  });

  const feed = useReadContract({
    address: oracle.data,
    abi: chainlinkRoundOracleAbi,
    functionName: "feed",
    chainId: activeChain.id,
    query: { enabled: Boolean(oracle.data), staleTime: Infinity },
  });

  const feedOwner = useReadContract({
    address: feed.data,
    abi: demoPriceFeedAbi,
    functionName: "owner",
    chainId: activeChain.id,
    query: { enabled: Boolean(feed.data) },
  });

  const latestRoundId = useReadContract({
    address: feed.data,
    abi: demoPriceFeedAbi,
    functionName: "latestRoundId",
    chainId: activeChain.id,
    query: { enabled: Boolean(feed.data), refetchInterval: 6_000 },
  });

  const isFeedOwner =
    feedOwner.data !== undefined && address.toLowerCase() === feedOwner.data.toLowerCase();

  // 8 decimals, matching the Chainlink USD feeds this stands in for.
  const parsed = /^\d+(\.\d{1,8})?$/.test(price.trim())
    ? BigInt(Math.round(Number(price) * 1e8))
    : null;
  const busy = tx.state.status === "signing" || tx.state.status === "pending";

  return (
    <Card className="border-warning/40 bg-warning/5">
      <h3 className="text-sm font-medium text-ink">Publish a price</h3>
      <p className="mt-1 text-xs text-ink-muted">
        This market&rsquo;s price is whatever you publish here. Settling a round takes{" "}
        <span className="font-medium text-warning">two pushes</span>: one before the close, which
        becomes the settlement price, and one after it, which proves the first was the last.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Price
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={busy}
            inputMode="decimal"
            className="tabular w-40 rounded-lg border border-border bg-ground px-3 py-2 text-sm text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          />
        </label>

        <button
          disabled={busy || parsed === null || !isFeedOwner}
          onClick={async () => {
            if (parsed === null || !feed.data) return;
            const ok = await tx.send({
              address: feed.data,
              abi: demoPriceFeedAbi,
              functionName: "push",
              args: [parsed],
            });
            if (ok) void latestRoundId.refetch();
          }}
          className="cursor-pointer rounded-lg bg-warning px-3 py-2 text-sm font-medium text-ground transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-warning focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Publishing…" : "Publish"}
        </button>

        {latestRoundId.data !== undefined && (
          <span className="text-xs text-ink-faint">
            latest feed round{" "}
            <span className="tabular text-ink">{latestRoundId.data.toString()}</span>
          </span>
        )}
      </div>

      {parsed === null && (
        <p className="mt-2 text-xs text-negative">
          A price, with at most 8 decimal places — the feed&rsquo;s scale.
        </p>
      )}
      {feedOwner.data !== undefined && !isFeedOwner && (
        <p className="mt-2 text-xs text-warning">
          Only <code>{short(feedOwner.data)}</code> can publish on this feed. Without that key the
          demo market cannot be settled at all.
        </p>
      )}
      <div className="mt-2">
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}

function SecondsField({
  label,
  value,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-ink-muted">{label}</span>
      <div className="flex items-baseline gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          inputMode="numeric"
          className="tabular w-full rounded-lg border border-border bg-ground px-3 py-2 text-sm text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        />
        <span className="text-xs text-ink-faint">s</span>
      </div>
      <span className="text-[11px] leading-relaxed text-ink-faint">{hint}</span>
    </label>
  );
}

function Preview({ label, at, now }: { label: string; at: bigint; now: bigint | undefined }) {
  return (
    <div>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="tabular text-ink">
        {new Date(Number(at) * 1000).toLocaleTimeString()}
        {now !== undefined && (
          <span className="ml-2 text-ink-faint">in {formatCountdown(at - now)}</span>
        )}
      </dd>
    </div>
  );
}

function actionLabel(action: ActionValue): string {
  switch (action) {
    case Action.Lock:
      return "Lock";
    case Action.VoidUnlocked:
      return "Unwind — never locked";
    case Action.VoidUnsettled:
      return "Refund — past the deadline";
    default:
      return "";
  }
}

function deadlineLabel(action: ActionValue, phase: PhaseValue): string {
  if (action === Action.Lock) return "lock window closes in";
  if (action === Action.Resolve) return "refundable in";
  if (phase === Phase.Observation) return "closes in";
  return "locks in";
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
