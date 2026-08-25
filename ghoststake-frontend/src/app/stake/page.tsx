"use client";

import { useState } from "react";
import { erc20Abi } from "viem";
import { useConnection, useReadContract } from "wagmi";
import { AmountField, TxStatus, parseAmount } from "@/components/AmountField";
import { AppShell, NeedsWallet, NotConfigured } from "@/components/AppShell";
import { Card, Stat } from "@/components/Card";
import { Faucet } from "@/components/Faucet";
import { Figure } from "@/components/Figure";
import { HealthFactorCard } from "@/components/HealthFactor";
import { useTransaction } from "@/hooks/useTransaction";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import { collateralVaultAbi } from "@/lib/abis";
import { contractsConfigured, env } from "@/lib/env";
import { formatAmount } from "@/lib/format";
import { activeChain } from "@/lib/wagmi";

export default function VaultPage() {
  const connection = useConnection();
  const position = useVaultPosition();

  return (
    <AppShell title="Stake" subtitle="Earns while it sits, and backs everything you borrow">
      {connection.status !== "connected" ? (
        <NeedsWallet what="Your stake, what it earns, and what you can borrow against it all live at your address." />
      ) : !contractsConfigured ? (
        <NotConfigured what="No stake vault is configured for this network." />
      ) : (
        <VaultScreen position={position} address={connection.address} />
      )}
    </AppShell>
  );
}

function VaultScreen({
  position,
  address,
}: {
  position: ReturnType<typeof useVaultPosition>;
  address: `0x${string}`;
}) {
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

      <Stat label="In your wallet" hint="available to deposit">
        <Figure
          value={formatAmount(walletBalance.data ?? 0n, decimals)}
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
      <div className="flex items-center gap-1 rounded-lg bg-raised p-1">
        {(["deposit", "withdraw"] as const).map((m) => (
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
            label={mode === "deposit" ? "Amount to deposit" : "Amount to withdraw"}
            value={amount}
            onChange={setAmount}
            max={max}
            decimals={decimals}
            symbol={symbol}
            maxLabel={mode === "deposit" ? "Wallet" : "Deposited"}
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
                ? `Approve and ${mode}`
                : mode === "deposit"
                  ? "Deposit"
                  : "Withdraw"}
          </button>

          {overMax && (
            <p className="text-xs text-negative">
              That is more than {mode === "deposit" ? "your wallet holds" : "you have deposited"}.
            </p>
          )}
          {partialExitBlocked && (
            <p className="text-xs text-warning">
              You have debt open against this position, so it can only be withdrawn in full. The
              lien is settled from the proceeds and the rest comes back to you.
            </p>
          )}
          <TxStatus state={tx.state} />
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-border bg-raised/40 p-4">
          <Line label="Staked" value={deposited} decimals={decimals} symbol={symbol} />
          <Line label="Shares" value={shares} decimals={18} symbol="gsCOL" />
          <Line label="Borrowed against it" value={lien} decimals={decimals} symbol={symbol} />
          <p className="mt-1 text-xs text-ink-muted">
            Your stake never leaves to back a loan — borrowing places a lien against it and the
            funds come from the lending pool. It keeps earning the whole time, which is the
            point: you take a view without unwinding your savings.
          </p>
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
          <div className="h-8 w-32 animate-pulse rounded bg-raised" />
        </Card>
      ))}
    </div>
  );
}
