"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { usePublicClient, useReadContract } from "wagmi";
import { useWallet } from "@/hooks/useWallet";
import { AmountField, TxStatus } from "@/components/AmountField";
import { Page, NeedsWallet, NotConfigured } from "@/components/Page";
import { Card } from "@/components/ui/Card";
import { FeesPanel } from "@/components/FeesPanel";
import { useMarketFeeds, type MarketFeed } from "@/hooks/useMarketFeeds";
import { useMarketShape } from "@/hooks/useMarketShape";
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
import { parseAmount } from "@/lib/amount";
import { useFormat } from "@/i18n/useFormat";
import { strikeFor } from "@/lib/strike";
import { anyMarketConfigured, type Market } from "@/lib/markets";
import {
  Action,
  actionFor,
  findCloseRound,
  isOwnerOnly,
  legacyOpenRoundAbi,
  scheduleFrom,
  scheduleProblem,
  warningsFor,
  type ActionValue,
} from "@/lib/operator";
import { Phase, Status, formatCountdown, phaseKey, type PhaseValue } from "@/lib/rounds";
import { activeChain } from "@/lib/wagmi";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { Badge } from "@/components/ui/Badge";

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
  const t = useTranslations("operator");
  const markets = useTranslations("markets");
  const wallet = useWallet();

  return (
    <Page title={t("title")} subtitle={t("subtitle")}>
      {!anyMarketConfigured() ? (
        <NotConfigured what={markets("notConfigured")} />
      ) : !wallet.isConnected ? (
        <NeedsWallet what={t("needsWallet")} />
      ) : (
        <Console address={wallet.address} />
      )}
    </Page>
  );
}

function Console({ address }: { address: `0x${string}` }) {
  const t = useTranslations("operator");
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
        <p className="text-sm text-ink-muted">{t("unreachable")}</p>
      </Card>
    );
  }

  if (marketsLoading || isLoading || params.byMarket.size === 0) {
    return (
      <Card>
        <Skeleton className="h-24" />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      {/* First, because it is the question an operator arrives with that the
          console could not previously answer at all. Everything below drives
          rounds; this is the only thing on the page about money the protocol
          has actually earned. See GHO-40. */}
      <FeesPanel
        markets={markets}
        address={address}
        decimals={position.decimals}
        symbol={position.symbol}
      />

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
  const t = useTranslations("operator");
  const feedT = useTranslations("feed");
  const isOwner = address.toLowerCase() === params.owner.toLowerCase();
  const label = feed ? (feed.description.split(" - ").pop() ?? t("marketFallback")) : feedT("reading");

  // Newest first, and only the ones still in play — a settled round needs no
  // operator and a list of them buries the two that do.
  const live = rounds.filter((r) => r.phase !== Phase.Resolved && r.phase !== Phase.Void);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold text-ink">{label}</h2>
        {feed?.isDemo && (
          <Badge>{feedT("demo")}</Badge>
        )}
        <span className="text-xs text-ink-faint">
          {isOwner ? (
            <span className="text-positive">{t("youOwn")}</span>
          ) : (
            t.rich("ownerIs", {
              owner: short(params.owner),
              code: (chunks) => <code className="text-ink-muted">{chunks}</code>,
            })
          )}
        </span>
      </div>

      {feed?.isDemo && <DemoFeedControl market={market} address={address} />}

      <OpenRoundForm market={market} params={params} isOwner={isOwner} now={now} onDone={refetch} />

      {live.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">{t("noRound")}</p>
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
  const { formatAmount } = useFormat();
  const t = useTranslations("operator.open");
  const root = useTranslations();
  const [lead, setLead] = useState("60");
  const [entry, setEntry] = useState("300");
  const [observation, setObservation] = useState("300");
  const [strike, setStrike] = useState("");
  const tx = useTransaction();

  // Which shape of `openRound` this deployment takes, and what it would
  // strike against (GHO-79). Both read from the chain rather than assumed:
  // the markets on Sepolia predate the strike and still have to be openable
  // from here.
  const shape = useMarketShape(market);
  const suggested = strikeFor(shape.spot);

  // The field is prefilled with the suggestion and stays editable — the
  // operator is the one person who should be able to ask a different
  // question, e.g. a round deliberately struck away from spot.
  const strikeInput = strike === "" ? (suggested === null ? "" : formatAmount(suggested, 18, 2)) : strike;
  const strikeAmount = strike === "" ? suggested : parseAmount(strike, 18);
  const strikeProblem =
    shape.strikeAtOpen && strikeAmount === null
      ? shape.spot === undefined
        ? t("noSpot")
        : t("notAPrice")
      : null;

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
      <h3 className="text-sm font-medium text-ink">{t("heading")}</h3>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <SecondsField label={t("lead")} value={lead} onChange={setLead} disabled={busy}
          hint={t("leadHint")} />
        <SecondsField label={t("entry")} value={entry} onChange={setEntry} disabled={busy}
          hint={t("entryHint", { cutoff: params.entryCutoff.toString() })} />
        <SecondsField label={t("observation")} value={observation} onChange={setObservation} disabled={busy}
          hint={t("observationHint")} />
      </div>

      {shape.strikeAtOpen && (
        <div className="mt-4">
          <AmountField
            label={t("strike")}
            value={strikeInput}
            onChange={setStrike}
            max={undefined}
            decimals={18}
            symbol="USD"
            disabled={busy}
            hint={
              suggested === null
                ? t("strikeHint")
                : t("strikeHintSpot", { spot: formatAmount(suggested, 18, 2) })
            }
          />
        </div>
      )}

      {shape.strikeAtOpen === false && (
        <p className="mt-4 text-xs text-ink-faint">{t("legacy")}</p>
      )}

      {schedule && (
        <dl className="mt-4 grid gap-2 rounded-sm border border-border bg-raised/40 p-3 text-xs sm:grid-cols-3">
          <Preview label={t("opens")} at={schedule.openTime} now={now} />
          <Preview label={t("locks")} at={schedule.lockTime} now={now} />
          <Preview label={t("closes")} at={schedule.closeTime} now={now} />
        </dl>
      )}

      {/* The feed's cadence, not ours, is the floor on a round's length —
          worth saying next to the observation window, where someone is about
          to choose one. */}
      <p className="mt-3 text-xs text-ink-faint">{t("heartbeat")}</p>

      {problem && <p className="mt-3 text-xs text-negative">{root(problem.key, problem.values)}</p>}
      {strikeProblem && <p className="mt-3 text-xs text-negative">{strikeProblem}</p>}

      {!isOwner && (
        <p className="mt-3 text-xs text-warning">{t("ownerOnly")}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button
          disabled={
            busy ||
            !schedule ||
            problem !== null ||
            !isOwner ||
            shape.strikeAtOpen === undefined ||
            strikeProblem !== null
          }
          onClick={async () => {
            if (!schedule) return;
            // The two live shapes of this contract. Sending the wrong one
            // reverts, so the argument list follows what the bytecode says
            // rather than what this build was compiled against.
            const ok = await tx.send(
              shape.strikeAtOpen && strikeAmount !== null
                ? {
                    address: market.address,
                    abi: parimutuelRoundAbi,
                    functionName: "openRound",
                    args: [schedule.openTime, schedule.lockTime, schedule.closeTime, strikeAmount],
                  }
                : {
                    address: market.address,
                    abi: legacyOpenRoundAbi,
                    functionName: "openRound",
                    args: [schedule.openTime, schedule.lockTime, schedule.closeTime],
                  },
            );
            if (ok) onDone();
          }}
        >
          {busy ? t("opening") : t("submit")}
        </Button>
        <TxStatus tx={tx} />
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
  const { formatAmount } = useFormat();
  const t = useTranslations("operator.round");
  const warn = useTranslations("operator.warnings");
  const phases = useTranslations("round.phases");
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
          <span className="text-sm font-medium text-ink">{t("title", { id: round.id.toString() })}</span>
          <span className="rounded-sm bg-raised px-2 py-0.5 text-xs text-ink-muted">
            {phases(phaseKey(phase))}
          </span>
          {decimals !== undefined && (
            <span className="tabular text-xs text-ink-faint">
              {t("pools", {
                up: formatAmount(round.round.upPool, decimals, 0),
                down: formatAmount(round.round.downPool, decimals, 0),
                symbol,
              })}
            </span>
          )}
        </div>
        {remaining !== undefined && (
          <span className="text-xs text-ink-faint">
            {t.rich(`deadline.${deadlineKey(action, phase)}`, {
              countdown: formatCountdown(remaining),
              figure: (chunks) => <span className="tabular text-ink">{chunks}</span>,
            })}
          </span>
        )}
      </header>

      {warnings.map((w) => (
        <p key={w.code} className="mt-3 text-xs text-warning">
          {warn(w.code)}
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
        <p className="mt-3 text-xs text-ink-muted">{t("nothingYet")}</p>
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
  const t = useTranslations("operator.round");
  const actions = useTranslations("actions");
  const tx = useTransaction();
  const busy = tx.state.status === "signing" || tx.state.status === "pending";
  const ownerOnly = isOwnerOnly(action);
  const key = actionKey(action);

  const fn =
    action === Action.Lock
      ? "lockRound"
      : action === Action.VoidUnlocked
        ? "voidUnlockedRound"
        : "voidUnsettledRound";

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button
        size="sm"
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
      >
        {busy ? actions("working") : key && t(`actions.${key}`)}
      </Button>
      <span className="text-xs text-ink-faint">
        {ownerOnly ? (isOwner ? t("ownerYou") : t("ownerOther")) : t("permissionless")}
      </span>
      <TxStatus tx={tx} />
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
  const { formatAmount } = useFormat();
  const t = useTranslations("operator.resolve");
  const client = usePublicClient({ chainId: activeChain.id });
  const tx = useTransaction();
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<
    | { kind: "none"; reason: "notPublished" | "unreadable" }
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
        setResult({ kind: "none", reason: "notPublished" });
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
      setResult({ kind: "none", reason: "unreadable" });
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
        <Button
          variant="outline"
          size="sm"
          disabled={searching || !feed.data}
          onClick={search}
        >
          {searching ? t("searching") : t("find")}
        </Button>
        <span className="text-xs text-ink-faint">{t("explain")}</span>
      </div>

      {result?.kind === "none" && <p className="text-xs text-warning">{t(result.reason)}</p>}

      {result?.kind === "refused" && (
        <p className="text-xs text-warning">{t("refused", { round: result.feedRound.toString() })}</p>
      )}

      {result?.kind === "found" && (
        <div className="flex flex-col gap-2 rounded-sm border border-border bg-raised/40 p-3">
          <p className="text-xs text-ink-muted">
            {t.rich("found", {
              round: result.feedRound.toString(),
              price: formatAmount(result.price, 18, 2),
              figure: (chunks) => <span className="tabular text-ink">{chunks}</span>,
            })}
          </p>
          {behindLock && <p className="text-xs text-negative">{t("behindLock")}</p>}
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              className="w-fit"
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
            >
              {busy ? t("resolving") : t("resolve")}
            </Button>
            <TxStatus tx={tx} />
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
  const t = useTranslations("operator.demo");
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
      <h3 className="text-sm font-medium text-ink">{t("heading")}</h3>
      <p className="mt-1 text-xs text-ink-muted">
        {t.rich("explain", { lead: (chunks) => <span className="font-medium text-warning">{chunks}</span> })}
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          {t("price")}
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={busy}
            inputMode="decimal"
            className="tabular w-40 rounded-sm border border-border bg-ground px-3 py-2 text-sm text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          />
        </label>

        <Button
          variant="warning"
          size="sm"
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
        >
          {busy ? t("publishing") : t("publish")}
        </Button>

        {latestRoundId.data !== undefined && (
          <span className="text-xs text-ink-faint">
            {t.rich("latest", { round: latestRoundId.data.toString(), figure: (chunks) => <span className="tabular text-ink">{chunks}</span> })}
          </span>
        )}
      </div>

      {parsed === null && (
        <p className="mt-2 text-xs text-negative">{t("badPrice")}</p>
      )}
      {feedOwner.data !== undefined && !isFeedOwner && (
        <p className="mt-2 text-xs text-warning">
          {t.rich("notOwner", { owner: short(feedOwner.data), code: (chunks) => <code>{chunks}</code> })}
        </p>
      )}
      <div className="mt-2">
        <TxStatus tx={tx} />
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
  const t = useTranslations("operator.open");
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-ink-muted">{label}</span>
      <div className="flex items-baseline gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          inputMode="numeric"
          className="tabular w-full rounded-sm border border-border bg-ground px-3 py-2 text-sm text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        />
        <span className="text-xs text-ink-faint">{t("secondsUnit")}</span>
      </div>
      <span className="text-[11px] leading-relaxed text-ink-faint">{hint}</span>
    </label>
  );
}

function Preview({ label, at, now }: { label: string; at: bigint; now: bigint | undefined }) {
  const { formatTime } = useFormat();
  const t = useTranslations("operator.open");
  return (
    <div>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="tabular text-ink">
        {formatTime(Number(at) * 1000)}
        {now !== undefined && (
          <span className="ml-2 text-ink-faint">{t("in", { countdown: formatCountdown(at - now) })}</span>
        )}
      </dd>
    </div>
  );
}

/** The action's button words are `operator.round.actions.<key>`. */
function actionKey(action: ActionValue): "lock" | "unwind" | "refund" | null {
  switch (action) {
    case Action.Lock:
      return "lock";
    case Action.VoidUnlocked:
      return "unwind";
    case Action.VoidUnsettled:
      return "refund";
    default:
      return null;
  }
}

/** Which deadline the countdown names: `operator.round.deadline.<key>`. */
function deadlineKey(action: ActionValue, phase: PhaseValue): "lockWindow" | "refundable" | "closes" | "locks" {
  if (action === Action.Lock) return "lockWindow";
  if (action === Action.Resolve) return "refundable";
  if (phase === Phase.Observation) return "closes";
  return "locks";
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
