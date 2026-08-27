"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { useConnection } from "wagmi";
import { AppShell, NeedsWallet } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { useActivityDecimals } from "@/hooks/useActivity";
import { useMarketFeeds } from "@/hooks/useMarketFeeds";
import { useMarkets } from "@/hooks/useMarkets";
import { roundKey, useClaimConfirmation, usePositions } from "@/hooks/usePositions";
import { useTransaction } from "@/hooks/useTransaction";
import { parimutuelRoundAbi } from "@/lib/abis";
import { shortHash } from "@/lib/activity";
import { formatAmount } from "@/lib/format";
import {
  byRecency,
  netOf,
  outcomeOf,
  sideTaken,
  type Outcome,
  type Position,
} from "@/lib/positions";

/**
 * Every view an address has taken, and how each one went (GHO-38).
 *
 * The gap this fills: `/markets` reads the twelve most recent rounds of each
 * *currently listed* market, straight off the chain. That is the right shape
 * for betting — the numbers decide a transaction about to be signed — and the
 * wrong shape for a record. A round thirteen back is gone. A market the
 * registry has delisted is gone. And the read costs a multicall per refresh:
 * `roundCount`, two calls per round, four more per round per connected wallet.
 *
 * `/api/v1/positions/{address}` has held all of it since GHO-17, already
 * summed and phase-resolved, in one request. Nothing consumed it — ADR 0023
 * said so at the time and left it deliberately. This is the follow-up.
 *
 * On why this is not `/history`, which is what the issue asked for: GHO-49
 * shipped `/activity` and captioned it "everything you did", and a nav
 * carrying both Activity and History offers a user two words for one promise.
 * The pages are genuinely different — Activity is the lending ledger, every
 * deposit and borrow and repay; this is the market ledger, the bets and their
 * outcomes — and naming them by what they hold rather than by how old they
 * are is what makes that difference visible from the nav.
 */
export default function PositionsPage() {
  return (
    // useSearchParams needs a Suspense boundary or the route opts out of
    // static rendering and the build fails.
    <Suspense fallback={null}>
      <PositionsScreen />
    </Suspense>
  );
}

function PositionsScreen() {
  const { address: connected } = useConnection();
  const params = useSearchParams();

  // `?address=` wins over the wallet, matching /activity. Every figure here is
  // public chain state, so there is nothing to gate — and the alternative is a
  // page nobody can demonstrate or support without someone's keys.
  const requested = params.get("address");
  const address = requested ?? connected;
  const viewingSomeoneElse = Boolean(
    requested && connected && requested.toLowerCase() !== connected.toLowerCase(),
  );

  const positions = usePositions(address ?? undefined);
  const decimals = useActivityDecimals();
  const { markets } = useMarkets();
  const feeds = useMarketFeeds(markets);

  // Settled and open together: a claim is possible on the former, and the
  // latter can void, which settles it. One source for "what does the chain say
  // I can collect".
  const claims = useClaimConfirmation(
    [...positions.history, ...positions.open],
    address ?? undefined,
  );

  const history = [...positions.history].sort(byRecency);
  const open = [...positions.open].sort(byRecency);

  const refresh = () => {
    void positions.refetch();
    void claims.refetch();
  };

  return (
    <AppShell title="Positions" subtitle="Every view you have taken, and how it went">
      {!address ? (
        <NeedsWallet what="Connect a wallet to see its positions, or open this page with ?address=0x…" />
      ) : (
        <div className="space-y-4">
          <Header
            address={address}
            viewingSomeoneElse={viewingSomeoneElse}
            indexedBlock={positions.indexedBlock}
          />

          {positions.isError ? (
            <Failed message={String(positions.error)} onRetry={refresh} />
          ) : positions.isLoading ? (
            <Card>
              <p className="text-sm text-ink-muted">Reading your positions…</p>
            </Card>
          ) : history.length === 0 && open.length === 0 ? (
            <Empty indexedBlock={positions.indexedBlock} />
          ) : (
            <>
              <Unclaimed
                positions={[...history, ...open]}
                claims={claims}
                address={address}
                decimals={decimals.assetDecimals}
                symbol={decimals.assetSymbol}
                onClaimed={refresh}
              />

              <Record
                history={history}
                decimals={decimals.assetDecimals}
                symbol={decimals.assetSymbol}
              />

              {open.length > 0 && (
                <Section title="Still running" count={open.length}>
                  <PositionsTable
                    positions={open}
                    feeds={feeds.byMarket}
                    decimals={decimals.assetDecimals}
                    symbol={decimals.assetSymbol}
                  />
                </Section>
              )}

              {history.length > 0 && (
                <Section title="Settled" count={history.length}>
                  <PositionsTable
                    positions={history}
                    feeds={feeds.byMarket}
                    decimals={decimals.assetDecimals}
                    symbol={decimals.assetSymbol}
                  />
                </Section>
              )}
            </>
          )}
        </div>
      )}
    </AppShell>
  );
}

/**
 * The lag, stated rather than hidden.
 *
 * The indexer sits `INDEXER_CONFIRMATIONS` behind the head on purpose, so a
 * position opened ten seconds ago is genuinely not here yet. Without this line
 * the page's answer to "where is the bet I just placed" is silence, and
 * silence about your own money reads as loss.
 */
function Header({
  address,
  viewingSomeoneElse,
  indexedBlock,
}: {
  address: string;
  viewingSomeoneElse: boolean;
  indexedBlock?: number;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">Address</p>
          <p className="mt-1 font-mono text-sm text-ink">{address}</p>
          {viewingSomeoneElse && (
            <p className="mt-1 text-xs text-ink-faint">
              Not your connected wallet — this is a public read.
            </p>
          )}
        </div>
        <p className="text-xs text-ink-faint">
          {indexedBlock
            ? `Indexed to block ${indexedBlock.toLocaleString()}. A position opened in the last few blocks is not here yet.`
            : "Indexer position unknown."}
        </p>
      </div>
    </Card>
  );
}

/**
 * Winnings sitting in the contract, and the only actionable thing on the page.
 *
 * A parimutuel payout is pull-based: a win nobody claims stays where it is,
 * indefinitely. `/markets` surfaces this for the twelve most recent rounds of
 * a listed market and no further, so a win from a fortnight ago — or from a
 * market since delisted — was unreachable and unmentioned.
 *
 * The amounts here come from the chain, not from the API. See
 * `useClaimConfirmation`: the indexer is blocks behind, so it keeps reporting
 * a claim as outstanding after it has been made, and a button built on that
 * offers a transaction that reverts.
 */
function Unclaimed({
  positions,
  claims,
  address,
  decimals,
  symbol,
  onClaimed,
}: {
  positions: Position[];
  claims: ReturnType<typeof useClaimConfirmation>;
  address: string;
  decimals?: number;
  symbol: string;
  onClaimed: () => void;
}) {
  // A missing key means the chain has not answered yet, which is not zero —
  // rendering it as zero would hide a real claim behind a loading state that
  // never announced itself.
  const rows = positions.filter((p) => (claims.confirmed.get(roundKey(p)) ?? 0n) > 0n);

  if (claims.isError) {
    return (
      <Card>
        <p className="text-sm text-ink">Could not check your claims against the chain.</p>
        <p className="mt-2 text-xs text-ink-faint">
          The settled record below is still accurate — it does not depend on this read. Claiming
          does, so no claim is offered until the chain answers.
        </p>
      </Card>
    );
  }

  if (rows.length === 0) {
    // Silent when there is nothing to claim, including while the reads are in
    // flight: an empty "Unclaimed" heading that resolves to nothing is a
    // flicker of good news.
    return null;
  }

  const total = rows.reduce((sum, p) => sum + (claims.confirmed.get(roundKey(p)) ?? 0n), 0n);

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
            Unclaimed winnings
          </p>
          <p className="tabular mt-1 text-lg font-medium text-positive">
            {decimals === undefined ? "…" : formatAmount(total, decimals, 2)} {symbol}
          </p>
        </div>
        <p className="max-w-sm text-xs text-ink-faint">
          A payout is pull-based: it stays in the contract until someone collects it. Debt is
          settled first; the rest reaches the wallet.
        </p>
      </div>

      <ul className="mt-4 divide-y divide-border/60">
        {rows.map((position) => (
          <ClaimRow
            key={roundKey(position)}
            position={position}
            amount={claims.confirmed.get(roundKey(position))!}
            address={address}
            decimals={decimals}
            symbol={symbol}
            onDone={onClaimed}
          />
        ))}
      </ul>
    </Card>
  );
}

function ClaimRow({
  position,
  amount,
  address,
  decimals,
  symbol,
  onDone,
}: {
  position: Position;
  amount: bigint;
  address: string;
  decimals?: number;
  symbol: string;
  onDone: () => void;
}) {
  const tx = useTransaction();
  const busy = tx.state.status === "signing" || tx.state.status === "pending";

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2.5">
      <span className="text-sm text-ink">
        Round {position.round.id}
        <span className="ml-2 font-mono text-xs text-ink-faint">
          {shortHash(position.round.market, 6, 4)}
        </span>
      </span>
      <span className="flex items-center gap-3">
        <span className="tabular text-sm text-positive">
          {decimals === undefined ? "…" : formatAmount(amount, decimals, 2)} {symbol}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            const ok = await tx.send({
              address: position.round.market as `0x${string}`,
              abi: parimutuelRoundAbi,
              functionName: "claim",
              args: [BigInt(position.round.id), address as `0x${string}`],
            });
            if (ok) onDone();
          }}
          className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-ground transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Claiming…" : "Claim"}
        </button>
      </span>
    </li>
  );
}

/**
 * The record: what the whole history adds up to.
 *
 * The one thing a full history can say that a twelve-round window cannot, and
 * the reason it is worth reading from the API at all.
 *
 * Voids are counted separately rather than folded into either column. A void
 * refunds the stake — it is not a win, and calling it a loss would be a lie
 * about money that came back. Excluding it from the win rate keeps that rate
 * an answer about judgement rather than about how often the oracle held up.
 */
function Record({
  history,
  decimals,
  symbol,
}: {
  history: Position[];
  decimals?: number;
  symbol: string;
}) {
  if (history.length === 0) return null;

  let staked = 0n;
  let net = 0n;
  let won = 0;
  let lost = 0;
  let voided = 0;

  for (const position of history) {
    staked += BigInt(position.totalStake);
    net += netOf(position) ?? 0n;
    const outcome = outcomeOf(position);
    if (outcome === "won") won += 1;
    else if (outcome === "lost") lost += 1;
    else if (outcome === "void") voided += 1;
  }

  const decided = won + lost;
  const fmt = (v: bigint) => (decimals === undefined ? "…" : formatAmount(v, decimals, 2));

  return (
    <Card>
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Settled" value={String(history.length)} />
        <Stat
          label="Won"
          value={decided === 0 ? "—" : `${won} of ${decided}`}
          hint={
            decided === 0
              ? voided > 0
                ? `${voided} voided`
                : undefined
              : `${Math.round((won / decided) * 100)}%${voided > 0 ? `, ${voided} voided` : ""}`
          }
        />
        <Stat label="Staked" value={`${fmt(staked)} ${symbol}`} />
        <Stat
          label="Net"
          value={`${net > 0n ? "+" : net < 0n ? "−" : ""}${fmt(net < 0n ? -net : net)} ${symbol}`}
          tone={net > 0n ? "positive" : net < 0n ? "negative" : "neutral"}
        />
      </div>
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "positive" | "negative" | "neutral";
}) {
  const colour =
    tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "text-ink";
  return (
    <div>
      <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</p>
      <p className={`tabular mt-1 text-lg font-medium ${colour}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="text-xs font-medium tracking-wide text-ink-muted uppercase">{title}</h2>
        <span className="h-px flex-1 bg-border" />
        <span className="text-[11px] text-ink-faint">{count}</span>
      </div>
      {children}
    </section>
  );
}

function PositionsTable({
  positions,
  feeds,
  decimals,
  symbol,
}: {
  positions: Position[];
  feeds: Map<string, { description: string }>;
  decimals?: number;
  symbol: string;
}) {
  return (
    <div className="overflow-x-auto rounded-card border border-border bg-surface">
      <table className="w-full min-w-[48rem] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs tracking-wide text-ink-faint uppercase">
            <th className="px-4 py-3 font-medium">When</th>
            <th className="px-4 py-3 font-medium">Market</th>
            <th className="px-4 py-3 font-medium">Side</th>
            <th className="px-4 py-3 text-right font-medium">Staked</th>
            <th className="px-4 py-3 font-medium">Outcome</th>
            <th className="px-4 py-3 text-right font-medium">Net</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <Row
              key={roundKey(position)}
              position={position}
              feed={feeds.get(position.round.market.toLowerCase())?.description}
              decimals={decimals}
              symbol={symbol}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  position,
  feed,
  decimals,
  symbol,
}: {
  position: Position;
  feed?: string;
  decimals?: number;
  symbol: string;
}) {
  const outcome = outcomeOf(position);
  const net = netOf(position);
  const side = sideTaken(position);
  const fmt = (v: bigint) => (decimals === undefined ? "…" : formatAmount(v, decimals, 2));

  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="px-4 py-3 whitespace-nowrap text-ink-muted">
        <time
          dateTime={position.round.closeTime}
          title={`Round opened ${new Date(position.round.openTime).toLocaleString()}`}
        >
          {new Date(position.round.closeTime).toLocaleString()}
        </time>
      </td>

      <td className="px-4 py-3">
        {/* The market is named, not just the round. Round ids restart at 1 in
            every market, so "round 7" alone names as many rounds as there are
            markets.

            The address is shown alongside the feed description rather than
            instead of it, because a description does not identify a market
            either. Rendering this page against the local stack put two rows
            side by side both reading "GHOSTSTAKE DEMO FEED … ETH / USD" — one
            from each of two entirely different contracts, since the local
            deploy gives both markets an operator-driven feed. Two markets
            sharing a feed is not a local quirk: nothing stops a second market
            on the same pair at a different horizon, which is exactly what the
            registry was built to allow. */}
        <span className="text-ink">{feed ?? "Market"}</span>
        <span className="ml-2 font-mono text-xs text-ink-faint">
          {shortHash(position.round.market, 6, 4)}
        </span>
        <span className="ml-2 text-xs text-ink-faint">round {position.round.id}</span>
        {position.leveraged && (
          <span className="ml-2 rounded bg-raised px-1.5 py-0.5 text-[11px] text-ink-faint">
            leveraged
          </span>
        )}
      </td>

      <td className="px-4 py-3 text-ink-muted">
        {side === "both" ? (
          <span title="Entered both sides of this round">
            up {fmt(BigInt(position.upStake))} · down {fmt(BigInt(position.downStake))}
          </span>
        ) : (
          side
        )}
      </td>

      <td className="px-4 py-3 text-right font-mono whitespace-nowrap text-ink">
        {fmt(BigInt(position.totalStake))} <span className="text-xs text-ink-faint">{symbol}</span>
      </td>

      <td className="px-4 py-3">
        <OutcomeTag outcome={outcome} voidReason={position.round.voidReason} />
      </td>

      <td className="px-4 py-3 text-right font-mono whitespace-nowrap">
        {net === null ? (
          // An unsettled round has no result. Rendering the live pool split as
          // a P&L would invite someone to read it as money they hold.
          <span className="text-ink-faint">—</span>
        ) : (
          <span
            className={net > 0n ? "text-positive" : net < 0n ? "text-negative" : "text-ink-muted"}
          >
            {net > 0n ? "+" : net < 0n ? "−" : ""}
            {fmt(net < 0n ? -net : net)}
          </span>
        )}
      </td>
    </tr>
  );
}

function OutcomeTag({ outcome, voidReason }: { outcome: Outcome; voidReason?: string }) {
  if (outcome === "void") {
    return (
      <span className="text-ink-muted" title={voidReason || undefined}>
        Voided — stake refunded
      </span>
    );
  }
  if (outcome === "won") return <span className="text-positive">Won</span>;
  if (outcome === "lost") return <span className="text-ink-muted">Lost</span>;
  return <span className="text-ink-faint">Running</span>;
}

function Empty({ indexedBlock }: { indexedBlock?: number }) {
  return (
    <Card>
      <p className="text-sm text-ink-muted">No positions indexed for this address yet.</p>
      <p className="mt-2 text-xs text-ink-faint">
        {indexedBlock
          ? `The indexer has read to block ${indexedBlock.toLocaleString()}. A position opened in the last few blocks will not be here yet.`
          : "The indexer has not reported a position, so it may not have run against this deployment."}
      </p>
    </Card>
  );
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card>
      <p className="text-sm text-ink">Could not read your positions.</p>
      <p className="mt-2 text-xs text-ink-faint">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-lg border border-border px-3 py-1.5 text-sm text-ink-muted hover:bg-raised/60 hover:text-ink"
      >
        Try again
      </button>
    </Card>
  );
}
