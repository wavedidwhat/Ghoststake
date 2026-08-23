"use client";

import { useConnection } from "wagmi";
import { Card, Stat } from "@/components/Card";
import { ConnectButton } from "@/components/ConnectButton";
import { Figure } from "@/components/Figure";
import { HealthFactorCard } from "@/components/HealthFactor";
import { NetworkGuard } from "@/components/NetworkGuard";
import { Sidebar } from "@/components/Sidebar";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import { contractsConfigured } from "@/lib/env";
import { formatAmount } from "@/lib/format";
import { activeChain } from "@/lib/wagmi";

export default function DashboardPage() {
  const connection = useConnection();
  const position = useVaultPosition();

  return (
    <div className="flex min-h-screen">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <NetworkGuard />

        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold">Dashboard</h1>
            <p className="text-xs text-ink-faint">{activeChain.name}</p>
          </div>
          <ConnectButton />
        </header>

        <main className="flex-1 p-6">
          {connection.status === "disconnected" ? (
            <Disconnected />
          ) : !contractsConfigured ? (
            <NotDeployed />
          ) : position.isError ? (
            <ReadFailed onRetry={() => position.refetch()} />
          ) : (
            <Position position={position} />
          )}
        </main>
      </div>
    </div>
  );
}

function Position({ position }: { position: ReturnType<typeof useVaultPosition> }) {
  const { decimals, symbol } = position;

  // Held back until the asset's decimals are known. Formatting a balance
  // against a guessed scale renders a plausible number that is wrong by
  // orders of magnitude, which is far worse than a skeleton for one frame.
  const amount = (value: bigint | undefined) =>
    value === undefined || decimals === undefined
      ? undefined
      : formatAmount(value, decimals);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* Health factor leads the page and spans the row. GHO-11: "visible
          from the first screen and never buried." */}
      <div className="lg:col-span-2">
        <HealthFactorCard value={position.healthFactor} />
      </div>

      <Stat label="Collateral value" hint="capped at redeemable">
        <PendingFigure value={amount(position.collateralValue)} unit={symbol} />
      </Stat>

      <Stat label="Accrued yield" hint="since last checkpoint">
        <PendingFigure value={amount(position.accruedYield)} unit={symbol} tone="positive" />
      </Stat>

      {/* Debt renders in accounting parentheses, as in the reference
          dashboard's "Borrows ($2,400.00)" — it is a claim against the
          position, not a balance it holds. */}
      <Stat label="Debt" hint="principal + interest">
        {position.lien === undefined || decimals === undefined ? (
          <Skeleton />
        ) : position.lien === 0n ? (
          <Figure value={formatAmount(0n, decimals)} unit={symbol} tone="muted" />
        ) : (
          <Figure
            value={`(${formatAmount(position.lien, decimals)})`}
            unit={symbol}
            tone="negative"
          />
        )}
      </Stat>

      <Stat label="Still borrowable" hint="to the LTV ceiling">
        <PendingFigure value={amount(position.maxBorrowable)} unit={symbol} />
      </Stat>
    </div>
  );
}

function PendingFigure({
  value,
  unit,
  tone,
}: {
  value: string | undefined;
  unit: string;
  tone?: "positive" | "muted";
}) {
  if (value === undefined) return <Skeleton />;
  return <Figure value={value} unit={unit} size="stat" tone={tone} />;
}

function Skeleton() {
  return <div className="h-8 w-32 animate-pulse rounded bg-raised" />;
}

function Disconnected() {
  return (
    <Card className="mx-auto mt-16 max-w-md text-center">
      <h2 className="text-lg font-semibold">Connect a wallet</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        GhostStake reads your position straight from the chain. Connecting is
        read-only — nothing is signed, and no transaction is proposed.
      </p>
      <div className="mt-5 flex justify-center">
        <ConnectButton />
      </div>
    </Card>
  );
}

/**
 * Distinct from "connected but empty" on purpose. Before GHO-21 deploys
 * there is no contract to read, and rendering that as a row of zeroes would
 * be indistinguishable from a real position with nothing in it.
 */
function NotDeployed() {
  return (
    <Card className="mx-auto mt-16 max-w-md text-center">
      <h2 className="text-lg font-semibold">Contracts not configured</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        No addresses are set for {activeChain.name}. Set{" "}
        <code className="text-ink">NEXT_PUBLIC_VAULT_ADDRESS</code> and{" "}
        <code className="text-ink">NEXT_PUBLIC_POOL_ADDRESS</code> once GHO-21
        has deployed.
      </p>
    </Card>
  );
}

function ReadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="mx-auto mt-16 max-w-md text-center">
      <h2 className="text-lg font-semibold text-warning">Could not read your position</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        The RPC call failed. Your position is unchanged — this screen just
        cannot see it right now.
      </p>
      <button
        onClick={onRetry}
        className="mt-5 rounded-full border border-border px-4 py-2 text-sm text-ink transition hover:border-border-strong"
      >
        Try again
      </button>
    </Card>
  );
}
