"use client";

import { useConnection } from "wagmi";
import { AppShell, NotConfigured } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { useActivityDecimals } from "@/hooks/useActivity";
import { useAtRisk } from "@/hooks/useAtRisk";
import { useTransaction } from "@/hooks/useTransaction";
import { collateralVaultAbi } from "@/lib/abis";
import { shortHash } from "@/lib/activity";
import { actionFor, netToLiquidator, type Action, type AtRiskPosition } from "@/lib/atRisk";
import { env } from "@/lib/env";
import { formatAmount, formatHealthFactor, healthBand } from "@/lib/format";

/**
 * The liquidator's screen (GHO-42).
 *
 * `liquidate` has been permissionless and tested to the point of fuzzing since
 * GHO-9, and nobody could call it — because every view in the protocol is
 * per-address, so you had to already know whose position was underwater. The
 * incentive existed, the mechanism existed, and the discovery step did not.
 * That is how a protocol accumulates bad debt while telling itself liquidation
 * is permissionless.
 *
 * The page is built around one honesty rule: **never offer a call that loses
 * money**. Past the point where collateral covers debt plus the bonus, no
 * repayment size leaves a liquidator ahead — so those rows do not get a
 * Liquidate button. They get the write-off, which is the call that actually
 * closes them, and which is openly labelled as paying nothing.
 */
export default function LiquidatePage() {
  const { status } = useConnection();
  const atRisk = useAtRisk();
  const decimals = useActivityDecimals();

  return (
    <AppShell title="Liquidate" subtitle="Positions past the line, and what closing them pays">
      {!env.vaultAddress ? (
        <NotConfigured what="No vault is configured for this network." />
      ) : (
        <div className="space-y-4">
          <Header
            block={atRisk.block}
            indexedBlock={atRisk.indexedBlock}
            scanned={atRisk.scanned}
            truncated={atRisk.truncated}
          />

          {atRisk.isError ? (
            <Failed message={String(atRisk.error)} onRetry={() => void atRisk.refetch()} />
          ) : atRisk.isLoading ? (
            <Card>
              <p className="text-sm text-ink-muted">Reading borrowers…</p>
            </Card>
          ) : atRisk.positions.length === 0 ? (
            <Card>
              <p className="text-sm text-ink-muted">Nobody is carrying debt right now.</p>
              <p className="mt-2 text-xs text-ink-faint">
                Every borrower the indexer has seen is listed here, healthy or not — an empty list
                means there are none, not that none are at risk.
              </p>
            </Card>
          ) : (
            <Table
              positions={atRisk.positions}
              connected={status === "connected"}
              decimals={decimals.assetDecimals}
              symbol={decimals.assetSymbol}
              onDone={() => void atRisk.refetch()}
            />
          )}
        </div>
      )}
    </AppShell>
  );
}

/**
 * Two block numbers, because they mean different things and conflating them
 * would be the wrong kind of reassuring.
 *
 * `indexedBlock` bounds *who* can appear: a borrower whose first draw is newer
 * than it has not been seen. `block` is where every *figure* was read, and it
 * is the chain head — so the health factors are current even though the roster
 * is a few blocks behind.
 */
function Header({
  block,
  indexedBlock,
  scanned,
  truncated,
}: {
  block?: number;
  indexedBlock?: number;
  scanned: number;
  truncated: boolean;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
            {scanned} borrower{scanned === 1 ? "" : "s"} scanned
          </p>
          <p className="mt-1 max-w-lg text-xs text-ink-faint">
            Names come from the indexer, which has every borrow and repayment. Figures are read from
            the chain at the head, so a health factor here is current.
          </p>
        </div>
        <p className="text-right text-xs text-ink-faint">
          {block ? `Figures at block ${block.toLocaleString()}.` : "Block unknown."}
          <br />
          {indexedBlock
            ? `Borrowers indexed to ${indexedBlock.toLocaleString()}.`
            : "Indexer position unknown."}
        </p>
      </div>

      {truncated && (
        <p className="mt-3 rounded-lg border border-border bg-raised/50 px-3 py-2 text-xs text-ink-muted">
          The scan cap was reached, so there may be more borrowers than these. The ones shown are
          those with the largest debt — a truncated list is missing the trivia, not the risk.
        </p>
      )}
    </Card>
  );
}

function Table({
  positions,
  connected,
  decimals,
  symbol,
  onDone,
}: {
  positions: AtRiskPosition[];
  connected: boolean;
  decimals?: number;
  symbol: string;
  onDone: () => void;
}) {
  return (
    <div className="overflow-x-auto rounded-card border border-border bg-surface">
      <table className="w-full min-w-[58rem] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs tracking-wide text-ink-faint uppercase">
            <th className="px-4 py-3 font-medium">Borrower</th>
            <th className="px-4 py-3 text-right font-medium">Health</th>
            <th className="px-4 py-3 text-right font-medium">Collateral</th>
            <th className="px-4 py-3 text-right font-medium">Debt</th>
            <th className="px-4 py-3 text-right font-medium">You repay</th>
            <th className="px-4 py-3 text-right font-medium">You receive</th>
            <th className="px-4 py-3 text-right font-medium">Net</th>
            <th className="px-4 py-3 font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <Row
              key={position.address}
              position={position}
              connected={connected}
              decimals={decimals}
              symbol={symbol}
              onDone={onDone}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  position,
  connected,
  decimals,
  symbol,
  onDone,
}: {
  position: AtRiskPosition;
  connected: boolean;
  decimals?: number;
  symbol: string;
  onDone: () => void;
}) {
  const action = actionFor(position);
  const net = netToLiquidator(position);
  const fmt = (v: bigint) => (decimals === undefined ? "…" : formatAmount(v, decimals, 2));

  // The same bands the dashboard uses, so "at risk" means one thing in both
  // places rather than two thresholds that happen to be near each other.
  const band = healthBand(BigInt(position.healthFactor));

  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="px-4 py-3 font-mono text-xs">
        <a
          href={`/positions?address=${position.address}`}
          className="text-ink-muted underline-offset-2 hover:text-ink hover:underline"
        >
          {shortHash(position.address, 8, 6)}
        </a>
      </td>

      <td
        className={`tabular px-4 py-3 text-right ${
          band === "danger" ? "text-negative" : band === "caution" ? "text-warning" : "text-ink"
        }`}
      >
        {formatHealthFactor(BigInt(position.healthFactor)) ?? "—"}
      </td>

      <td className="tabular px-4 py-3 text-right text-ink-muted">
        {fmt(BigInt(position.collateral))}
      </td>
      <td className="tabular px-4 py-3 text-right text-ink-muted">{fmt(BigInt(position.debt))}</td>

      {action !== "liquidate" ? (
        // Nothing to quote, and the write-off case is the one worth being
        // careful about. These three columns describe a *liquidation*, and a
        // write-off is not one: it costs the caller nothing and pays them
        // nothing. Rendering "you repay 10,000 / net −5,000" beside a Write
        // off button says the opposite, and that is how somebody decides not
        // to make a free call the protocol needs made.
        //
        // Found by looking at the page, not by reading it.
        <>
          <td className="px-4 py-3 text-right text-ink-faint">—</td>
          <td className="px-4 py-3 text-right text-ink-faint">—</td>
          <td className="px-4 py-3 text-right text-ink-faint">—</td>
        </>
      ) : (
        <>
          <td className="tabular px-4 py-3 text-right text-ink">
            {fmt(BigInt(position.maxRepay))}
          </td>
          <td className="tabular px-4 py-3 text-right text-ink">{fmt(BigInt(position.seized))}</td>
          <td
            className={`tabular px-4 py-3 text-right ${net > 0n ? "text-positive" : "text-negative"}`}
          >
            {net > 0n ? "+" : "−"}
            {fmt(net < 0n ? -net : net)} <span className="text-xs text-ink-faint">{symbol}</span>
          </td>
        </>
      )}

      <td className="px-4 py-3">
        <ActionCell
          position={position}
          action={action}
          connected={connected}
          decimals={decimals}
          symbol={symbol}
          onDone={onDone}
        />
      </td>
    </tr>
  );
}

function ActionCell({
  position,
  action,
  connected,
  decimals,
  symbol,
  onDone,
}: {
  position: AtRiskPosition;
  action: Action;
  connected: boolean;
  decimals?: number;
  symbol: string;
  onDone: () => void;
}) {
  const tx = useTransaction();
  const busy = tx.state.status === "signing" || tx.state.status === "pending";

  if (action === "watch") {
    return (
      <span className="text-xs text-ink-faint">
        {position.liquidatable
          ? // Underwater, but nobody comes out ahead. Named rather than left
            // as a missing button, because the absence is the information.
            "Underwater, but a liquidation loses money here"
          : "Healthy"}
      </span>
    );
  }

  if (action === "write-off") {
    return (
      <div className="flex flex-col gap-1">
        {/* The button is gated on a wallet; the explanation below is not.
            Without that split this row read exactly like a healthy one to a
            disconnected visitor — same dashes, same "Connect a wallet" — so
            the one position on the page that most needs somebody's attention
            was the least distinguishable on it. */}
        {!connected ? (
          <span className="text-xs text-ink">Connect a wallet to write off</span>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              const ok = await tx.send({
                address: env.vaultAddress!,
                abi: collateralVaultAbi,
                functionName: "writeOffBadDebt",
                args: [position.address as `0x${string}`],
              });
              if (ok) onDone();
            }}
            className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-raised/60 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Writing off…" : "Write off"}
          </button>
        )}
        <span className="text-[11px] text-ink-faint">
          Owes more than it holds, so no liquidation closes it. Pays you nothing; it ends the
          position and charges the loss to reserves, then to suppliers.
        </span>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs text-ink">Connect a wallet to liquidate</span>
        <span className="text-[11px] text-ink-faint">
          {position.fullLiquidation ? "Clears the whole lien" : "Capped at the close factor"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          // `maxUint256` rather than the API's `maxRepay`. The quote was
          // computed at the API's block and interest has accrued since; the
          // contract's sentinel means "the most you are allowed right now",
          // which is the figure the transaction will actually be held to. A
          // literal amount would revert as ExceedsCloseFactor the moment the
          // position moved between the read and the send.
          const ok = await tx.send({
            address: env.vaultAddress!,
            abi: collateralVaultAbi,
            functionName: "liquidate",
            args: [position.address as `0x${string}`, 2n ** 256n - 1n],
          });
          if (ok) onDone();
        }}
        className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-ground transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Liquidating…" : "Liquidate"}
      </button>
      <span className="text-[11px] text-ink-faint">
        {position.fullLiquidation ? "Clears the whole lien" : "Capped at the close factor"} · you
        need {decimals === undefined ? "…" : formatAmount(BigInt(position.maxRepay), decimals, 2)}{" "}
        {symbol} approved to the vault
      </span>
    </div>
  );
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card>
      <p className="text-sm text-ink">Could not read the borrower list.</p>
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
