"use client";

import { useState } from "react";
import { erc20Abi } from "viem";
import { useConnection, useReadContract } from "wagmi";
import { AmountField, TxStatus, parseAmount } from "@/components/AmountField";
import { AppShell, NeedsWallet, NotConfigured } from "@/components/AppShell";
import { Card, Stat } from "@/components/Card";
import { Figure } from "@/components/Figure";
import { HealthFactorCard } from "@/components/HealthFactor";
import { useTransaction } from "@/hooks/useTransaction";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import { collateralVaultAbi } from "@/lib/abis";
import { contractsConfigured, env } from "@/lib/env";
import { formatAmount, formatHealthFactor, healthBand } from "@/lib/format";
import { activeChain } from "@/lib/wagmi";

export default function BorrowPage() {
  const connection = useConnection();
  const position = useVaultPosition();

  return (
    <AppShell title="Borrow" subtitle="Draw against your collateral, or repay what you owe">
      {connection.status !== "connected" ? (
        <NeedsWallet what="Borrowing capacity is a property of your deposited collateral." />
      ) : !contractsConfigured ? (
        <NotConfigured what="No vault is configured for this network." />
      ) : position.decimals === undefined ? (
        <Card>
          <div className="h-24 animate-pulse rounded bg-raised" />
        </Card>
      ) : (
        <BorrowScreen position={position} address={connection.address} />
      )}
    </AppShell>
  );
}

function BorrowScreen({
  position,
  address,
}: {
  position: ReturnType<typeof useVaultPosition>;
  address: `0x${string}`;
}) {
  const decimals = position.decimals!;
  const [mode, setMode] = useState<"borrow" | "repay">("borrow");
  const [amount, setAmount] = useState("");
  const tx = useTransaction();

  const wallet = useReadContract({
    address: position.assetAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
    chainId: activeChain.id,
    query: { enabled: Boolean(position.assetAddress), refetchInterval: 12_000 },
  });

  const allowance = useReadContract({
    address: position.assetAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address, env.vaultAddress!],
    chainId: activeChain.id,
    query: { enabled: Boolean(position.assetAddress) },
  });

  const parsed = parseAmount(amount, decimals);

  // Repaying is capped at the debt by the contract, so offering more than the
  // lien as a maximum would propose an amount that silently does less than it
  // says. Borrowing is capped at the LTV headroom.
  const max = mode === "borrow" ? position.maxBorrowable : position.lien;
  const overMax = parsed !== null && max !== undefined && parsed > max;
  const overWallet =
    mode === "repay" && parsed !== null && wallet.data !== undefined && parsed > wallet.data;
  const needsApproval = mode === "repay" && parsed !== null && (allowance.data ?? 0n) < parsed;

  const preview = previewHealth(position, mode === "borrow" ? (parsed ?? 0n) : -(parsed ?? 0n));

  const busy = tx.state.status === "signing" || tx.state.status === "pending";
  const disabled = busy || parsed === null || parsed === 0n || overMax || overWallet;

  async function submit() {
    if (parsed === null) return;

    if (needsApproval) {
      const ok = await tx.send({
        address: position.assetAddress!,
        abi: erc20Abi,
        functionName: "approve",
        args: [env.vaultAddress!, parsed],
      });
      if (!ok) return;
      await allowance.refetch();
    }

    const ok = await tx.send(
      mode === "borrow"
        ? {
            address: env.vaultAddress!,
            abi: collateralVaultAbi,
            functionName: "borrow",
            args: [parsed],
          }
        : {
            address: env.vaultAddress!,
            abi: collateralVaultAbi,
            functionName: "repay",
            args: [parsed, address],
          },
    );

    if (ok) {
      setAmount("");
      position.refetch();
      void wallet.refetch();
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <HealthFactorCard value={position.healthFactor} liquidatable={position.isLiquidatable} />
      </div>

      <Stat label="Still borrowable" hint="to the LTV ceiling">
        <Figure
          value={formatAmount(position.maxBorrowable ?? 0n, decimals)}
          unit={position.symbol}
          size="stat"
        />
      </Stat>

      <div className="lg:col-span-3">
        <Card>
          <div className="flex items-center gap-1 rounded-lg bg-raised p-1">
            {(["borrow", "repay"] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setAmount("");
                  tx.reset();
                }}
                className={`flex-1 cursor-pointer rounded-md px-3 py-2 text-sm font-medium capitalize transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                  mode === m ? "bg-surface text-ink" : "text-ink-muted hover:text-ink"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-4">
              <AmountField
                label={mode === "borrow" ? "Amount to borrow" : "Amount to repay"}
                value={amount}
                onChange={setAmount}
                max={max}
                decimals={decimals}
                symbol={position.symbol}
                maxLabel={mode === "borrow" ? "Capacity" : "Owed"}
                disabled={busy}
              />

              <button
                onClick={submit}
                disabled={disabled}
                className="cursor-pointer rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-ground transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy
                  ? "Working…"
                  : needsApproval
                    ? "Approve and repay"
                    : mode === "borrow"
                      ? "Borrow"
                      : "Repay"}
              </button>

              {overMax && (
                <p className="text-xs text-negative">
                  {mode === "borrow"
                    ? "Above your borrowing capacity."
                    : "More than you owe. Repaying is capped at the debt."}
                </p>
              )}
              {overWallet && (
                <p className="text-xs text-negative">More than your wallet holds.</p>
              )}
              <TxStatus state={tx.state} />
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-border bg-raised/40 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-ink-muted">Health factor after</span>
                <span className="flex items-baseline gap-2">
                  {position.healthFactor !== undefined && (
                    <span className="tabular text-xs text-ink-faint">
                      {formatHealthFactor(position.healthFactor) ?? "—"} →
                    </span>
                  )}
                  <span className={`tabular text-base font-medium ${previewTone(preview)}`}>
                    {preview === null ? "—" : (formatHealthFactor(preview) ?? "—")}
                  </span>
                </span>
              </div>
              <p className="text-xs text-ink-muted">
                Interest accrues every second at the pool&rsquo;s current rate, so the debt grows
                on its own between transactions. Borrowing stops at the LTV ceiling, which sits
                well below the liquidation line.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

/**
 * The health factor after a debt change, computed the way the vault computes
 * it. `delta` is signed: positive to borrow, negative to repay.
 *
 * Returns null when the resulting debt is zero, because there is no ratio to
 * show — the card renders the no-debt case itself.
 */
function previewHealth(
  position: ReturnType<typeof useVaultPosition>,
  delta: bigint,
): bigint | null {
  const { collateralValue, lien, liquidationThreshold } = position;
  if (collateralValue === undefined || lien === undefined || liquidationThreshold === undefined) {
    return null;
  }
  const debt = lien + delta;
  if (debt <= 0n) return null;
  return (collateralValue * liquidationThreshold) / debt;
}

function previewTone(preview: bigint | null): string {
  if (preview === null) return "text-ink-muted";
  const band = healthBand(preview);
  return band === "danger" ? "text-negative" : band === "caution" ? "text-warning" : "text-positive";
}
