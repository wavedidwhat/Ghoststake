"use client";

import { useState } from "react";
import { erc20Abi } from "viem";
import { useConnection, useReadContract } from "wagmi";
import { AmountField, TxStatus, parseAmount } from "@/components/AmountField";
import { AppShell, NeedsWallet, NotConfigured } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { RoundCard } from "@/components/RoundCard";
import { useNow } from "@/hooks/useNow";
import { useMarketParams, useRounds } from "@/hooks/useRounds";
import { useTransaction } from "@/hooks/useTransaction";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import {
  borrowToPositionRouterAbi,
  collateralVaultAbi,
  parimutuelRoundAbi,
} from "@/lib/abis";
import { env, marketConfigured } from "@/lib/env";
import { formatAmount, formatHealthFactor, healthBand } from "@/lib/format";
import { Phase, Side, type PhaseValue, type SideValue } from "@/lib/rounds";
import { activeChain } from "@/lib/wagmi";

export default function RoundsPage() {
  const connection = useConnection();

  return (
    <AppShell title="Rounds" subtitle="Take a side on where the price closes">
      {!marketConfigured ? (
        <NotConfigured what="No market is configured for this network. The Sepolia deployment predates the router." />
      ) : connection.status !== "connected" ? (
        <NeedsWallet what="Positions are tied to your address, so a wallet is needed to see or open one." />
      ) : (
        <RoundsScreen address={connection.address} />
      )}
    </AppShell>
  );
}

function RoundsScreen({ address }: { address: `0x${string}` }) {
  const now = useNow();
  const params = useMarketParams();
  const { rounds, isLoading, isError, refetch } = useRounds();
  const position = useVaultPosition();

  const [staking, setStaking] = useState<{ id: bigint; side: SideValue } | null>(null);

  if (isError) {
    return (
      <Card>
        <p className="text-sm text-ink-muted">
          Rounds could not be read. The chain is unreachable right now — nothing about your
          positions has changed.
        </p>
      </Card>
    );
  }

  if (isLoading || params.entryCutoff === undefined || position.decimals === undefined) {
    return <Card><div className="h-24 animate-pulse rounded bg-raised" /></Card>;
  }

  if (rounds.length === 0) {
    return (
      <Card>
        <p className="text-sm text-ink-muted">
          No rounds have opened yet. Rounds are scheduled by the keeper (GHO-24); until it runs,
          the owner opens them by hand.
        </p>
      </Card>
    );
  }

  const live = rounds.filter((r) => r.phase !== Phase.Resolved && r.phase !== Phase.Void);
  const done = rounds.filter((r) => r.phase === Phase.Resolved || r.phase === Phase.Void);

  return (
    <div className="flex flex-col gap-8">
      <Section title="Live" empty="Nothing open right now.">
        {live.map((r) => (
          <RoundCard
            key={r.id.toString()}
            id={r.id}
            round={r.round}
            phase={(r.phase ?? Phase.None) as PhaseValue}
            entryCutoff={params.entryCutoff!}
            minSidePool={params.minSidePool!}
            rake={params.rake!}
            decimals={position.decimals!}
            symbol={position.symbol}
            now={now}
            yourUp={r.up}
            yourDown={r.down}
            onStake={(side) => setStaking({ id: r.id, side })}
          >
            {staking?.id === r.id && (
              <StakeForm
                roundId={r.id}
                side={staking.side}
                address={address}
                position={position}
                onClose={() => setStaking(null)}
                onDone={() => {
                  setStaking(null);
                  refetch();
                  position.refetch();
                }}
              />
            )}
          </RoundCard>
        ))}
      </Section>

      <Section title="Settled" empty="Nothing has settled yet.">
        {done.map((r) => (
          <RoundCard
            key={r.id.toString()}
            id={r.id}
            round={r.round}
            phase={(r.phase ?? Phase.None) as PhaseValue}
            entryCutoff={params.entryCutoff!}
            minSidePool={params.minSidePool!}
            rake={params.rake!}
            decimals={position.decimals!}
            symbol={position.symbol}
            now={now}
            yourUp={r.up}
            yourDown={r.down}
          >
            <ClaimRow
              roundId={r.id}
              claimable={r.claimable}
              claimed={r.isClaimed}
              staked={(r.up ?? 0n) + (r.down ?? 0n)}
              decimals={position.decimals!}
              symbol={position.symbol}
              address={address}
              onDone={() => {
                refetch();
                position.refetch();
              }}
            />
          </RoundCard>
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="text-xs font-medium tracking-wide text-ink-muted uppercase">{title}</h2>
        <span className="h-px flex-1 bg-border" />
      </div>
      {children.length === 0 ? (
        <p className="text-sm text-ink-faint">{empty}</p>
      ) : (
        <div className="flex flex-col gap-3">{children}</div>
      )}
    </section>
  );
}

/**
 * Stake into a round, from the wallet or against collateral.
 *
 * Borrowing routes through `BorrowToPositionRouter.openPosition`, which is one
 * transaction: the funds go vault → router → round and are never spendable in
 * between. The health factor preview below is the number that decides whether
 * someone should do it, so it is shown before the button, not after.
 */
function StakeForm({
  roundId,
  side,
  address,
  position,
  onClose,
  onDone,
}: {
  roundId: bigint;
  side: SideValue;
  address: `0x${string}`;
  position: ReturnType<typeof useVaultPosition>;
  onClose: () => void;
  onDone: () => void;
}) {
  const decimals = position.decimals!;
  const [own, setOwn] = useState("");
  const [borrow, setBorrow] = useState("");
  const tx = useTransaction();

  const wallet = useReadContract({
    address: position.assetAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
    chainId: activeChain.id,
    query: { enabled: Boolean(position.assetAddress) },
  });

  const routerAllowance = useReadContract({
    address: position.assetAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address, env.routerAddress!],
    chainId: activeChain.id,
    query: { enabled: Boolean(position.assetAddress) },
  });

  const delegation = useReadContract({
    address: env.vaultAddress!,
    abi: collateralVaultAbi,
    functionName: "borrowAllowance",
    args: [address, env.routerAddress!],
    chainId: activeChain.id,
  });

  const ownAmount = parseAmount(own || "0", decimals) ?? 0n;
  const borrowAmount = parseAmount(borrow || "0", decimals) ?? 0n;
  const total = ownAmount + borrowAmount;

  const overWallet = wallet.data !== undefined && ownAmount > wallet.data;
  const overCapacity =
    position.maxBorrowable !== undefined && borrowAmount > position.maxBorrowable;

  const needsTokenApproval =
    ownAmount > 0n && (routerAllowance.data ?? 0n) < ownAmount;
  const needsDelegation = borrowAmount > 0n && (delegation.data ?? 0n) < borrowAmount;

  const preview = previewHealth(position, borrowAmount);

  const busy = tx.state.status === "signing" || tx.state.status === "pending";
  const disabled = busy || total === 0n || overWallet || overCapacity;

  async function submit() {
    if (needsTokenApproval) {
      const ok = await tx.send({
        address: position.assetAddress!,
        abi: erc20Abi,
        functionName: "approve",
        args: [env.routerAddress!, ownAmount],
      });
      if (!ok) return;
      await routerAllowance.refetch();
    }

    if (needsDelegation) {
      // Approved for exactly this borrow rather than unlimited. An unlimited
      // delegation hands the router the whole LTV headroom for as long as it
      // stands, which is more than this one action needs.
      const ok = await tx.send({
        address: env.vaultAddress!,
        abi: collateralVaultAbi,
        functionName: "approveBorrowDelegate",
        args: [env.routerAddress!, borrowAmount],
      });
      if (!ok) return;
      await delegation.refetch();
    }

    const ok = await tx.send({
      address: env.routerAddress!,
      abi: borrowToPositionRouterAbi,
      functionName: "openPosition",
      args: [roundId, side, borrowAmount, ownAmount],
    });
    if (ok) onDone();
  }

  return (
    <div className="mt-4 flex flex-col gap-4 rounded-xl border border-border-strong bg-raised/60 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink">
          Take {side === Side.Up ? "Up" : "Down"} on round {roundId.toString()}
        </h3>
        <button
          onClick={onClose}
          className="cursor-pointer text-xs text-ink-faint transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          Cancel
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <AmountField
          label="From your wallet"
          value={own}
          onChange={setOwn}
          max={wallet.data}
          decimals={decimals}
          symbol={position.symbol}
          maxLabel="Wallet"
          disabled={busy}
        />
        <AmountField
          label="Borrowed against collateral"
          value={borrow}
          onChange={setBorrow}
          max={position.maxBorrowable}
          decimals={decimals}
          symbol={position.symbol}
          maxLabel="Capacity"
          disabled={busy}
          hint="Goes straight from the vault into the round. It never reaches your wallet."
        />
      </div>

      {borrowAmount > 0n && preview && (
        <HealthPreview
          before={position.healthFactor}
          after={preview}
          decimals={decimals}
          borrowAmount={borrowAmount}
          symbol={position.symbol}
        />
      )}

      {overWallet && <p className="text-xs text-negative">More than your wallet holds.</p>}
      {overCapacity && (
        <p className="text-xs text-negative">
          Above your borrowing capacity. The vault would refuse this at the LTV ceiling.
        </p>
      )}

      <button
        onClick={submit}
        disabled={disabled}
        className="cursor-pointer rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-ground transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy
          ? "Working…"
          : needsTokenApproval || needsDelegation
            ? `Approve and stake ${formatAmount(total, decimals, 2)}`
            : `Stake ${formatAmount(total, decimals, 2)} ${position.symbol}`}
      </button>

      <TxStatus state={tx.state} />
    </div>
  );
}

/**
 * What the health factor becomes if this borrow goes through.
 *
 * Computed the same way the vault does — `collateral × threshold ÷ debt` —
 * rather than approximated. A preview that disagrees with the contract is
 * worse than no preview, because it is the number someone decides on.
 *
 * Returns null when there is nothing to divide by.
 */
function previewHealth(
  position: ReturnType<typeof useVaultPosition>,
  borrowAmount: bigint,
): bigint | null {
  const { collateralValue, lien, liquidationThreshold } = position;
  if (collateralValue === undefined || lien === undefined || liquidationThreshold === undefined) {
    return null;
  }
  const debt = lien + borrowAmount;
  if (debt === 0n) return null;
  return (collateralValue * liquidationThreshold) / debt;
}

function HealthPreview({
  before,
  after,
  decimals,
  borrowAmount,
  symbol,
}: {
  before: bigint | undefined;
  after: bigint;
  decimals: number;
  borrowAmount: bigint;
  symbol: string;
}) {
  const band = healthBand(after);
  const tone =
    band === "danger" ? "text-negative" : band === "caution" ? "text-warning" : "text-positive";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-muted">Health factor after borrowing</span>
        <span className="flex items-baseline gap-2">
          {before !== undefined && (
            <span className="tabular text-xs text-ink-faint">
              {formatHealthFactor(before) ?? "—"} →
            </span>
          )}
          <span className={`tabular text-base font-medium ${tone}`}>
            {formatHealthFactor(after) ?? "—"}
          </span>
        </span>
      </div>
      <p className="text-xs text-ink-muted">
        Borrowing {formatAmount(borrowAmount, decimals, 2)} {symbol} against your collateral. If
        the round loses, the debt stands and is repaid from collateral.
      </p>
      {band === "danger" && (
        <p className="text-xs text-negative">
          This leaves you close to the liquidation line before the round has even started.
        </p>
      )}
    </div>
  );
}

/**
 * The claim row on a settled round.
 *
 * A win states the amount and offers the claim. A loss states what was staked
 * and stops — no encouragement to try again, and nothing dressed up.
 */
function ClaimRow({
  roundId,
  claimable,
  claimed,
  staked,
  decimals,
  symbol,
  address,
  onDone,
}: {
  roundId: bigint;
  claimable: bigint | undefined;
  claimed: boolean | undefined;
  staked: bigint;
  decimals: number;
  symbol: string;
  address: `0x${string}`;
  onDone: () => void;
}) {
  const tx = useTransaction();
  const busy = tx.state.status === "signing" || tx.state.status === "pending";

  if (staked === 0n) return null;

  if (claimed) {
    return <p className="mt-3 text-xs text-ink-muted">Claimed.</p>;
  }

  if (claimable === undefined || claimable === 0n) {
    return (
      <p className="mt-3 text-xs text-ink-muted">
        You staked <span className="tabular">{formatAmount(staked, decimals, 2)}</span> {symbol} on
        this round.
      </p>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-ink">
        <span className="tabular font-medium text-positive">
          {formatAmount(claimable, decimals, 2)} {symbol}
        </span>{" "}
        to claim. Debt is settled first; the rest reaches your wallet.
      </p>
      <div className="flex items-center gap-3">
        <TxStatus state={tx.state} />
        <button
          disabled={busy}
          onClick={async () => {
            const ok = await tx.send({
              address: env.marketAddress!,
              abi: parimutuelRoundAbi,
              functionName: "claim",
              args: [roundId, address],
            });
            if (ok) onDone();
          }}
          className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-ground transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Claiming…" : "Claim"}
        </button>
      </div>
    </div>
  );
}
