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
import { Faucet } from "@/components/Faucet";
import { Figure } from "@/components/ui/Figure";
import { HealthFactorCard } from "@/components/HealthFactor";
import { useTransaction } from "@/hooks/useTransaction";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import { collateralVaultAbi } from "@/lib/abis";
import { contractsConfigured, env } from "@/lib/env";
import { formatAmount, formatOptional } from "@/lib/format";
import { activeChain } from "@/lib/wagmi";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";

export default function VaultPage() {
  const t = useTranslations("stake");
  const wallet = useWallet();
  const position = useVaultPosition();

  return (
    <Page title={t("title")} subtitle={t("subtitle")}>
      {!wallet.isConnected ? (
        <NeedsWallet what={t("needsWallet")} />
      ) : !contractsConfigured ? (
        <NotConfigured what={t("notConfigured")} />
      ) : (
        <VaultScreen position={position} address={wallet.address} />
      )}
    </Page>
  );
}

function VaultScreen({
  position,
  address,
}: {
  position: ReturnType<typeof useVaultPosition>;
  address: `0x${string}`;
}) {
  const t = useTranslations("stake");
  const { decimals, symbol } = position;

  const walletBalance = useReadContract({
    address: position.assetAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
    chainId: activeChain.id,
    query: { enabled: Boolean(position.assetAddress), refetchInterval: 12_000 },
  });

  if (decimals === undefined) return <Loading />;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <HealthFactorCard value={position.healthFactor} liquidatable={position.isLiquidatable} />
      </div>

      <Stat label={t("inWallet")} hint={t("inWalletHint")}>
        <Figure
          // "…", not 0.00, while the read is pending or has failed: a zero
          // balance is a claim about the wallet, and a failed read is not
          // one (GHO-86).
          value={formatOptional(walletBalance.data, (v) => formatAmount(v, decimals)) ?? "…"}
          unit={symbol}
          size="stat"
        />
      </Stat>

      <div className="lg:col-span-3">
        <Faucet
          assetAddress={position.assetAddress}
          decimals={decimals}
          symbol={symbol}
          address={address}
          onMinted={() => {
            position.refetch();
            void walletBalance.refetch();
          }}
        />
      </div>

      <div className="lg:col-span-3">
        <DepositWithdraw
          address={address}
          assetAddress={position.assetAddress}
          decimals={decimals}
          symbol={symbol}
          walletBalance={walletBalance.data}
          deposited={position.collateralValue}
          shares={position.shares}
          lien={position.lien}
          onDone={() => {
            position.refetch();
            void walletBalance.refetch();
          }}
        />
      </div>
    </div>
  );
}

function DepositWithdraw({
  address,
  assetAddress,
  decimals,
  symbol,
  walletBalance,
  deposited,
  shares,
  lien,
  onDone,
}: {
  address: `0x${string}`;
  assetAddress: `0x${string}` | undefined;
  decimals: number;
  symbol: string;
  walletBalance: bigint | undefined;
  deposited: bigint | undefined;
  shares: bigint | undefined;
  lien: bigint | undefined;
  onDone: () => void;
}) {
  const t = useTranslations("stake");
  const actions = useTranslations("actions");
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const tx = useTransaction();

  const allowance = useReadContract({
    address: assetAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address, env.vaultAddress!],
    chainId: activeChain.id,
    query: { enabled: Boolean(assetAddress), refetchInterval: 12_000 },
  });

  const parsed = parseAmount(amount, decimals);
  const max = mode === "deposit" ? walletBalance : deposited;
  const overMax = parsed !== null && max !== undefined && parsed > max;
  const needsApproval =
    mode === "deposit" && parsed !== null && (allowance.data ?? 0n) < parsed;

  // A lien blocks a partial exit outright — the vault refuses anything short
  // of the whole position. Better said here than discovered as a revert.
  const hasLien = (lien ?? 0n) > 0n;
  const partialExitBlocked =
    mode === "withdraw" && hasLien && parsed !== null && deposited !== undefined && parsed < deposited;

  const busy = tx.state.status === "signing" || tx.state.status === "pending";
  const disabled = busy || parsed === null || parsed === 0n || overMax || partialExitBlocked;

  async function submit() {
    if (parsed === null) return;

    if (needsApproval) {
      const ok = await tx.send({
        address: assetAddress!,
        abi: erc20Abi,
        functionName: "approve",
        args: [env.vaultAddress!, parsed],
      });
      if (!ok) return;
      await allowance.refetch();
    }

    const ok = await tx.send(
      mode === "deposit"
        ? {
            address: env.vaultAddress!,
            abi: collateralVaultAbi,
            functionName: "deposit",
            args: [parsed, address],
          }
        : {
            // `withdraw` takes assets, which is what the field holds. Using
            // `redeem` would mean converting to shares here and racing the
            // exchange rate between the quote and the transaction.
            address: env.vaultAddress!,
            abi: collateralVaultAbi,
            functionName: "withdraw",
            args: [parsed, address, address],
          },
    );

    if (ok) {
      setAmount("");
      onDone();
    }
  }

  return (
    <Card>
      <SegmentedControl
        label={t("modeLabel")}
        options={[
          { value: "deposit", label: t("deposit") },
          { value: "withdraw", label: t("withdraw") },
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
            label={mode === "deposit" ? t("amountToDeposit") : t("amountToWithdraw")}
            value={amount}
            onChange={setAmount}
            max={max}
            decimals={decimals}
            symbol={symbol}
            maxLabel={mode === "deposit" ? t("walletMax") : t("depositedMax")}
            disabled={busy}
          />

          <Button
            onClick={submit}
            disabled={disabled}
          >
            {busy
              ? actions("working")
              : needsApproval
                ? t("approveAnd", { mode })
                : mode === "deposit"
                  ? t("deposit")
                  : t("withdraw")}
          </Button>

          {overMax && (
            <p className="text-xs text-negative">{t("overMax", { mode })}</p>
          )}
          {partialExitBlocked && (
            <p className="text-xs text-warning">{t("partialExitBlocked")}</p>
          )}
          <TxStatus tx={tx} />
        </div>

        <div className="flex flex-col gap-3 rounded-sm border border-border bg-raised/40 p-4">
          <Line label={t("staked")} value={deposited} decimals={decimals} symbol={symbol} />
          <Line label={t("shares")} value={shares} decimals={18} symbol="gsCOL" />
          <Line label={t("borrowed")} value={lien} decimals={decimals} symbol={symbol} />
          <p className="mt-1 text-xs text-ink-muted">{t("neverLeaves")}</p>
        </div>
      </div>
    </Card>
  );
}

function Line({
  label,
  value,
  decimals,
  symbol,
}: {
  label: string;
  value: bigint | undefined;
  decimals: number;
  symbol: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-ink-muted">{label}</span>
      <span className="tabular text-sm text-ink">
        {value === undefined ? "—" : `${formatAmount(value, decimals, 4)} ${symbol}`}
      </span>
    </div>
  );
}

function Loading() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <Skeleton className="h-8 w-32" />
        </Card>
      ))}
    </div>
  );
}
