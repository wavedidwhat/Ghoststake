"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { erc20Abi } from "viem";
import { useReadContract } from "wagmi";
import { useWallet } from "@/hooks/useWallet";
import { AmountField, TxStatus } from "@/components/AmountField";
import { parseAmount } from "@/lib/amount";
import { Page, NeedsWallet, NotConfigured } from "@/components/Page";
import { Card, Stat } from "@/components/ui/Card";
import { Figure } from "@/components/ui/Figure";
import { HealthFactorCard } from "@/components/HealthFactor";
import { useTransaction } from "@/hooks/useTransaction";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import { collateralVaultAbi } from "@/lib/abis";
import { contractsConfigured, env } from "@/lib/env";
import { formatOptional, healthBand } from "@/lib/format";
import { useFormat } from "@/i18n/useFormat";
import { activeChain } from "@/lib/wagmi";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";

export default function BorrowPage() {
  const t = useTranslations("borrow");
  const wallet = useWallet();
  const position = useVaultPosition();

  return (
    <Page title={t("title")} subtitle={t("subtitle")}>
      {!wallet.isConnected ? (
        <NeedsWallet what={t("needsWallet")} />
      ) : !contractsConfigured ? (
        <NotConfigured what={t("notConfigured")} />
      ) : position.decimals === undefined ? (
        <Card>
          <Skeleton className="h-24" />
        </Card>
      ) : (
        <BorrowScreen position={position} decimals={position.decimals} address={wallet.address} />
      )}
    </Page>
  );
}

/**
 * `decimals` is its own prop, narrowed by the caller, rather than read off
 * `position` and asserted (GHO-86). The assertion made the guard above and
 * the claim here two separate facts in two functions, and nothing kept them
 * together — a new caller skipping the guard would format every figure at
 * whatever scale `undefined` fell through to.
 */
function BorrowScreen({
  position,
  decimals,
  address,
}: {
  position: ReturnType<typeof useVaultPosition>;
  decimals: number;
  address: `0x${string}`;
}) {
  const { formatAmount, formatHealthFactor } = useFormat();
  const t = useTranslations("borrow");
  const vault = useTranslations("vault");
  const actions = useTranslations("actions");
  const amounts = useTranslations("amount");
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

      <Stat label={vault("stillBorrowable")} hint={vault("stillBorrowableHint")}>
        <Figure
          value={formatOptional(position.maxBorrowable, (v) => formatAmount(v, decimals)) ?? "…"}
          unit={position.symbol}
          size="stat"
        />
      </Stat>

      <div className="lg:col-span-3">
        <Card>
          <SegmentedControl
            label={t("modeLabel")}
            options={[
              { value: "borrow", label: t("borrow") },
              { value: "repay", label: t("repay") },
            ]}
            value={mode}
            onChange={(m) => {
              setMode(m);
              setAmount("");
              tx.reset();
            }}
          />

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-4">
              <AmountField
                label={mode === "borrow" ? t("amountToBorrow") : t("amountToRepay")}
                value={amount}
                onChange={setAmount}
                max={max}
                decimals={decimals}
                symbol={position.symbol}
                maxLabel={mode === "borrow" ? t("capacityMax") : t("owedMax")}
                disabled={busy}
              />

              <Button
                onClick={submit}
                disabled={disabled}
              >
                {busy
                  ? actions("working")
                  : needsApproval
                    ? t("approveAndRepay")
                    : mode === "borrow"
                      ? t("borrow")
                      : t("repay")}
              </Button>

              {overMax && (
                <p className="text-xs text-negative">
                  {mode === "borrow" ? t("overCapacity") : t("overDebt")}
                </p>
              )}
              {overWallet && (
                <p className="text-xs text-negative">{amounts("overWallet")}</p>
              )}
              <TxStatus tx={tx} />
            </div>

            <div className="flex flex-col gap-3 rounded-sm border border-border bg-raised/40 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-ink-muted">{vault("healthAfter")}</span>
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
              <p className="text-xs text-ink-muted">{t("interestNote")}</p>
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
