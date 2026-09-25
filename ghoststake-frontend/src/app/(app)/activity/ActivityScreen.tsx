"use client";

import { useConnection } from "wagmi";
import { Page, NeedsWallet } from "@/components/Page";
import { RowCard, RowField, RowList } from "@/components/ui/Rows";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Card } from "@/components/ui/Card";
import { useActivity, useActivityDecimals } from "@/hooks/useActivity";
import {
  activityDirection,
  activityLabel,
  explorerTxUrl,
  shortHash,
  wasLeveraged,
  type ActivityEvent,
} from "@/lib/activity";
import { formatAmount } from "@/lib/format";
import { Eyebrow } from "@/components/ui/Eyebrow";

/**
 * Everything one address has done here, on one page (GHO-49).
 *
 * The gap this fills: the protocol has recorded every deposit, borrow, repay,
 * supply, liquidation, position and claim since the indexer was built, in an
 * append-only ledger designed for exactly this read — and nothing ever
 * exposed it. `/positions/{address}` answers "what bets am I in", `/health`
 * answers "where do I stand right now", and between them the lending half of
 * the product — the half it is named after — had no history surface at all.
 *
 * Functionality before design, deliberately. One dense list, newest first,
 * every row traceable to its transaction. Grouping, filtering, a running
 * balance and a chart are all things this data supports and none of them are
 * here — the page is built so they can be added, not built around them.
 *
 * `requested` is `?address=`, read by the server page and passed in.
 */
export function ActivityScreen({ requested }: { requested: string | undefined }) {
  const { address: connected } = useConnection();

  // `?address=` wins over the wallet, so a history can be opened for any
  // address without connecting one. Every figure here is derived from public
  // chain state, so there is nothing to gate — and the alternative is that
  // the page cannot be demonstrated or supported without someone's keys.
  const address = requested ?? connected;
  const viewingSomeoneElse = Boolean(
    requested && connected && requested.toLowerCase() !== connected.toLowerCase(),
  );

  const activity = useActivity(address ?? undefined);
  const decimals = useActivityDecimals();

  return (
    <Page title="Activity" subtitle="Everything this address has done here, newest first">
      {!address ? (
        <NeedsWallet what="Connect a wallet to see its history, or open this page with ?address=0x…" />
      ) : (
        <div className="space-y-4">
          <Header
            address={address}
            viewingSomeoneElse={viewingSomeoneElse}
            indexedBlock={activity.indexedBlock}
          />

          {activity.isError ? (
            <LoadFailed
              title="Could not read the history"
              detail={String(activity.error)}
              onRetry={() => void activity.refetch()}
            />
          ) : activity.isLoading ? (
            <Card>
              <p className="text-sm text-ink-muted">Reading the ledger…</p>
            </Card>
          ) : activity.events.length === 0 ? (
            <Empty indexedBlock={activity.indexedBlock} />
          ) : (
            <>
              <ActivityTable
                events={activity.events}
                address={address}
                assetDecimals={decimals.assetDecimals}
                shareDecimals={decimals.shareDecimals}
                assetSymbol={decimals.assetSymbol}
              />
              {activity.hasMore && (
                <button
                  type="button"
                  onClick={() => void activity.loadMore()}
                  disabled={activity.isLoadingMore}
                  className="w-full rounded-card border border-border bg-surface py-3 text-sm text-ink-muted transition-colors hover:bg-raised/60 hover:text-ink disabled:opacity-50"
                >
                  {activity.isLoadingMore ? "Loading…" : "Load older"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </Page>
  );
}

/**
 * The lag, stated rather than hidden.
 *
 * The indexer sits `INDEXER_CONFIRMATIONS` behind the chain head on purpose,
 * so a transaction that just landed is genuinely not here yet. Without this
 * line the page's answer to "where is the deposit I made ten seconds ago" is
 * silence, and silence about your own money reads as loss.
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
          <Eyebrow>Address</Eyebrow>
          <p className="mt-1 font-mono text-sm text-ink">{address}</p>
          {viewingSomeoneElse && (
            <p className="mt-1 text-xs text-ink-faint">
              Not your connected wallet — this is a public read.
            </p>
          )}
        </div>
        <p className="text-xs text-ink-faint">
          {indexedBlock
            ? `Indexed to block ${indexedBlock.toLocaleString()}. Anything newer is not here yet.`
            : "Indexer position unknown."}
        </p>
      </div>
    </Card>
  );
}

function ActivityTable({
  events,
  address,
  assetDecimals,
  shareDecimals,
  assetSymbol,
}: {
  events: ActivityEvent[];
  address: string;
  assetDecimals?: number;
  shareDecimals?: number;
  assetSymbol: string;
}) {
  const rows = events.map((event) => ({
    event,
    // Formatted once and shared by both layouts, so the phone and the desktop
    // can never disagree about a figure.
    formatted: formatEvent(event, { address, assetDecimals, shareDecimals, assetSymbol }),
  }));

  return (
    <>
      <RowList>
        {rows.map(({ event, formatted }) => (
          <RowCard
            key={event.id}
            title={
              <>
                <span className="text-sm text-ink">{activityLabel(event)}</span>
                {formatted.leveraged && (
                  <span className="ml-2 rounded-sm bg-raised px-1.5 py-0.5 text-[11px] text-ink-faint">
                    leveraged
                  </span>
                )}
                <time
                  dateTime={event.blockTime}
                  className="mt-1 block text-xs text-ink-faint"
                  title={`Block ${event.blockNumber.toLocaleString()}`}
                >
                  {new Date(event.blockTime).toLocaleString()}
                </time>
              </>
            }
            aside={
              <span className={`tabular font-mono text-sm ${formatted.tone}`}>
                {formatted.sign}
                {formatted.amount}
                <span className="ml-1 text-xs text-ink-faint">{formatted.unit}</span>
              </span>
            }
          >
            <RowField label="Detail">
              <Detail event={event} />
            </RowField>
            <RowField label="Transaction">
              <TxLink hash={event.txHash} />
            </RowField>
          </RowCard>
        ))}
      </RowList>

      <div className="hidden overflow-x-auto rounded-card border border-border bg-surface sm:block">
      <table className="w-full min-w-[52rem] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs tracking-wide text-ink-faint uppercase">
            <th className="px-4 py-3 font-medium">When</th>
            <th className="px-4 py-3 font-medium">What</th>
            <th className="px-4 py-3 text-right font-medium">Amount</th>
            <th className="px-4 py-3 font-medium">Detail</th>
            <th className="px-4 py-3 text-right font-medium">Transaction</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <Row
              key={event.id}
              event={event}
              address={address}
              assetDecimals={assetDecimals}
              shareDecimals={shareDecimals}
              assetSymbol={assetSymbol}
            />
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}

/**
 * Everything about an event that both layouts need to agree on.
 *
 * Shares and the underlying asset have different decimals — the vault's
 * `_decimalsOffset()` is 6 — so one number formatted with the other's is
 * wrong by a factor of a million and looks entirely plausible. Rendered as
 * raw units until both are known rather than guessed at.
 *
 * The sign comes from the direction rather than from the number: the API
 * sends absolute amounts so that nothing has to interpret a minus sign
 * meaning "the balance went down" as "you lost this".
 */
function formatEvent(
  event: ActivityEvent,
  {
    address,
    assetDecimals,
    shareDecimals,
    assetSymbol,
  }: {
    address: string;
    assetDecimals?: number;
    shareDecimals?: number;
    assetSymbol: string;
  },
) {
  const direction = activityDirection(event);
  const decimals = event.asset === "shares" ? shareDecimals : assetDecimals;

  return {
    amount: decimals === undefined ? "…" : formatAmount(BigInt(event.amount), decimals, 4),
    unit: event.asset === "shares" ? "shares" : assetSymbol,
    sign: direction === "in" ? "+" : direction === "out" ? "−" : "",
    tone:
      direction === "in" ? "text-positive" : direction === "out" ? "text-ink" : "text-ink-muted",
    leveraged: wasLeveraged(event, address),
  };
}

/** The hash, linked if this chain has an explorer. */
function TxLink({ hash }: { hash: string }) {
  const explorer = explorerTxUrl(hash);

  return explorer ? (
    <a
      href={explorer}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-ink-muted underline-offset-2 hover:text-ink hover:underline"
    >
      {shortHash(hash)}
    </a>
  ) : (
    // No explorer on this chain — a local anvil. The hash is still the useful
    // thing; a link that goes nowhere is not.
    <span className="font-mono text-ink-faint">{shortHash(hash)}</span>
  );
}

function Row({
  event,
  address,
  assetDecimals,
  shareDecimals,
  assetSymbol,
}: {
  event: ActivityEvent;
  address: string;
  assetDecimals?: number;
  shareDecimals?: number;
  assetSymbol: string;
}) {
  const formatted = formatEvent(event, { address, assetDecimals, shareDecimals, assetSymbol });

  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="px-4 py-3 whitespace-nowrap text-ink-muted">
        <time dateTime={event.blockTime} title={`Block ${event.blockNumber.toLocaleString()}`}>
          {new Date(event.blockTime).toLocaleString()}
        </time>
      </td>

      <td className="px-4 py-3">
        <span className="text-ink">{activityLabel(event)}</span>
        {formatted.leveraged && (
          <span className="ml-2 rounded-sm bg-raised px-1.5 py-0.5 text-[11px] text-ink-faint">
            leveraged
          </span>
        )}
      </td>

      <td className="px-4 py-3 text-right font-mono whitespace-nowrap">
        <span className={formatted.tone}>
          {formatted.sign}
          {formatted.amount}
        </span>
        <span className="ml-1 text-xs text-ink-faint">{formatted.unit}</span>
      </td>

      <td className="px-4 py-3 text-ink-muted">
        <Detail event={event} />
      </td>

      <td className="px-4 py-3 text-right text-xs whitespace-nowrap">
        <TxLink hash={event.txHash} />
      </td>
    </tr>
  );
}

function Detail({ event }: { event: ActivityEvent }) {
  if (event.roundId) {
    return (
      <span>
        Round {event.roundId}
        {event.side && <> · {event.side === "up" ? "yes" : "no"}</>}
        {/* The market is shown, not just the round id. Round ids restart at 1
            in every market, so "round 7" on its own names as many different
            rounds as there are markets. */}
        {event.market && (
          <span className="ml-1 font-mono text-xs text-ink-faint">
            {shortHash(event.market, 6, 4)}
          </span>
        )}
      </span>
    );
  }
  if (event.counterparty) {
    return (
      <span className="font-mono text-xs">
        {shortHash(event.counterparty, 6, 4)}
      </span>
    );
  }
  return <span className="text-ink-faint">—</span>;
}

function Empty({ indexedBlock }: { indexedBlock?: number }) {
  return (
    <Card>
      <p className="text-sm text-ink-muted">Nothing indexed for this address yet.</p>
      <p className="mt-2 text-xs text-ink-faint">
        {indexedBlock
          ? `The indexer has read to block ${indexedBlock.toLocaleString()}. A transaction sent in the last few blocks will not be here yet.`
          : "The indexer has not reported a position, so it may not have run against this deployment."}
      </p>
    </Card>
  );
}

