"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { erc20Abi } from "viem";
import { useReadContract } from "wagmi";
import { useWallet } from "@/hooks/useWallet";
import { AmountField, TxStatus } from "@/components/AmountField";
import { parseAmount } from "@/lib/amount";
import { Page, NotConfigured } from "@/components/Page";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Card, Stat } from "@/components/ui/Card";
import { Faucet } from "@/components/Faucet";
import { Figure } from "@/components/ui/Figure";
import { useLendPosition } from "@/hooks/useLendPosition";
import { useTransaction } from "@/hooks/useTransaction";
import { borrowLiquidityPoolAbi } from "@/lib/abis";
import { env, poolConfigured } from "@/lib/env";
import { formatAmount, formatApr, formatPercent } from "@/lib/format";
import {
  lendWarnings,
  maxWithdraw,
  shareOfPool,
  utilizationAfter,
  withdrawProblem,
} from "@/lib/lend";
import { activeChain } from "@/lib/wagmi";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Skeleton } from "@/components/ui/Skeleton";

/**
 * The supply side of the lending market.
 *
 * Until GHO-39 this did not exist: `supply` and `withdraw` were not in a
 * page, not in a hook, and not even in the generated ABI, so the only
 * supplier on any deployment was the seed script. Every borrow drew from a
 * pool no user could add to, and the kinked interest-rate curve governed
 * something nobody could experience.
 *
 * The page is built around one number. Utilization is a lender's yield and
 * their exit risk at the same time, and showing the first without the second
 * is selling the upside of a position without its terms — see `lib/lend.ts`.
 */
export default function LendPage() {
  const t = useTranslations("lend");
  const pool = useLendPosition();

  return (
    <Page title={t("title")} subtitle={t("subtitle")}>
      {!poolConfigured ? (
        <NotConfigured what={t("notConfigured")} />
      ) : pool.isError ? (
        <LoadFailed
          title={t("unreadable")}
          onRetry={pool.refetch}
          className="mx-auto mt-16 max-w-md text-center"
        >
          {t("unreadableDetail")}
        </LoadFailed>
      ) : pool.decimals === undefined ? (
        <Loading />
      ) : (
        <LendScreen pool={pool} decimals={pool.decimals} />
      )}
    </Page>
  );
}

// `decimals` narrowed by the caller rather than asserted here (GHO-86); see
// BorrowScreen for why the two must be one fact.
function LendScreen({
  pool,
  decimals,
}: {
  pool: ReturnType<typeof useLendPosition>;
  decimals: number;
}) {
  const t = useTranslations("lend");
  const wallet = useWallet();
  const { symbol } = pool;

  const balance = pool.balance ?? 0n;
  const share = shareOfPool(balance, pool.totalSupplied ?? 0n);

  const warnings = lendWarnings({
    balance,
    available: pool.availableLiquidity ?? 0n,
    utilization: pool.utilization ?? 0n,
    kink: pool.kink ?? 0n,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-3">
        <PoolStrip pool={pool} decimals={decimals} symbol={symbol} />
      </div>

      <Stat label={t("yourSupply")} hint={t("yourSupplyHint")}>
        <Figure
          value={pool.balance === undefined ? "—" : formatAmount(balance, decimals)}
          unit={symbol}
          size="stat"
          tone={balance === 0n ? "muted" : "default"}
        />
      </Stat>

      <Stat label={t("share")} hint={t("shareHint")}>
        <Figure
          value={pool.balance === undefined ? "—" : formatPercent(share)}
          unit=""
          size="stat"
          tone={balance === 0n ? "muted" : "default"}
        />
      </Stat>

      <Stat label={t("withdrawable")} hint={t("withdrawableHint")}>
        <Figure
          value={
            pool.balance === undefined || pool.availableLiquidity === undefined
              ? "—"
              : formatAmount(maxWithdraw(balance, pool.availableLiquidity), decimals)
          }
          unit={symbol}
          size="stat"
          tone={
            pool.availableLiquidity !== undefined && balance > pool.availableLiquidity
              ? "warning"
              : "muted"
          }
        />
      </Stat>

      {warnings.length > 0 && (
        <div className="flex flex-col gap-2 lg:col-span-3">
          {warnings.map((w) => (
            <p
              key={w.code}
              className="rounded-sm border border-border bg-raised/40 px-4 py-3 text-xs leading-relaxed text-ink-muted"
            >
              {t(`warnings.${w.code}`)}
            </p>
          ))}
        </div>
      )}

      {!wallet.isConnected ? (
        <div className="lg:col-span-3">
          <Card className="text-center">
            <h2 className="text-base font-medium text-ink">{t("connectToSupply")}</h2>
            <p className="mt-2 text-sm text-ink-muted">{t("connectToSupplyDetail")}</p>
          </Card>
        </div>
      ) : (
        <>
          <div className="lg:col-span-3">
            <Faucet
              assetAddress={pool.assetAddress}
              decimals={decimals}
              symbol={symbol}
              address={wallet.address}
              onMinted={pool.refetch}
            />
          </div>
          <div className="lg:col-span-3">
            <SupplyWithdraw pool={pool} decimals={decimals} address={wallet.address} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The pool as a lender reads it: what it pays, and what it is doing with the
 * money that makes it pay that.
 */
function PoolStrip({
  pool,
  decimals,
  symbol,
}: {
  pool: ReturnType<typeof useLendPosition>;
  decimals: number;
  symbol: string;
}) {
  const t = useTranslations("lend.pool");
  const utilization = pool.utilization;
  const kink = pool.kink;
  const strained = utilization !== undefined && kink !== undefined && utilization > kink;

  return (
    <section className="rounded-card border border-border bg-surface p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-ink">{t("heading")}</h2>
        {pool.borrowRatePerSecond !== undefined && (
          <span className="text-xs text-ink-faint">
            {t.rich("borrowersPay", {
              rate: formatApr(pool.borrowRatePerSecond),
              figure: (chunks) => <span className="tabular text-ink">{chunks}</span>,
            })}
          </span>
        )}
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Line
          label={t("supplyRate")}
          hint={t("simpleAnnualised")}
          value={
            pool.supplyRatePerSecond === undefined
              ? undefined
              : formatApr(pool.supplyRatePerSecond)
          }
          tone="positive"
        />
        <Line
          label={t("utilization")}
          hint={kink === undefined ? undefined : t("target", { kink: formatPercent(kink, 0) })}
          value={utilization === undefined ? undefined : formatPercent(utilization)}
          tone={strained ? "warning" : "default"}
        />
        <Line
          label={t("available")}
          hint={t("availableHint")}
          value={
            pool.availableLiquidity === undefined
              ? undefined
              : `${formatAmount(pool.availableLiquidity, decimals, 2)} ${symbol}`
          }
        />
        <Line
          label={t("suppliedBorrowed")}
          hint={t("suppliedBorrowedHint")}
          value={
            pool.totalSupplied === undefined || pool.totalBorrowed === undefined
              ? undefined
              : `${formatAmount(pool.totalSupplied, decimals, 0)} / ${formatAmount(pool.totalBorrowed, decimals, 0)}`
          }
        />
      </div>

      {/* The sentence the whole page exists to make sayable. */}
      <p className="mt-5 text-xs leading-relaxed text-ink-muted">{t("utilizationNote")}</p>
    </section>
  );
}

function SupplyWithdraw({
  pool,
  decimals,
  address,
}: {
  pool: ReturnType<typeof useLendPosition>;
  decimals: number;
  address: `0x${string}`;
}) {
  const t = useTranslations("lend");
  const actions = useTranslations("actions");
  const amounts = useTranslations("amount");
  const { symbol } = pool;
  const [mode, setMode] = useState<"supply" | "withdraw">("supply");
  const [amount, setAmount] = useState("");
  const tx = useTransaction();

  const wallet = useReadContract({
    address: pool.assetAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
    chainId: activeChain.id,
    query: { enabled: Boolean(pool.assetAddress), refetchInterval: 12_000 },
  });

  const allowance = useReadContract({
    address: pool.assetAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address, env.poolAddress!],
    chainId: activeChain.id,
    query: { enabled: Boolean(pool.assetAddress), refetchInterval: 12_000 },
  });

  const balance = pool.balance ?? 0n;
  const available = pool.availableLiquidity ?? 0n;
  const parsed = parseAmount(amount, decimals);

  // Withdrawing is capped at the *reachable* maximum, not the balance. The
  // contract has two separate reverts here and the Max button has to respect
  // the tighter one, or it proposes a transaction that fails.
  const max = mode === "supply" ? wallet.data : maxWithdraw(balance, available);

  const overWallet =
    mode === "supply" && parsed !== null && wallet.data !== undefined && parsed > wallet.data;
  const problem =
    mode === "withdraw" && parsed !== null
      ? withdrawProblem(parsed, balance, available)
      : null;
  const needsApproval = mode === "supply" && parsed !== null && (allowance.data ?? 0n) < parsed;

  const delta = mode === "supply" ? (parsed ?? 0n) : -(parsed ?? 0n);
  const preview =
    pool.totalBorrowed === undefined || pool.availableLiquidity === undefined
      ? null
      : utilizationAfter(pool.totalBorrowed, pool.availableLiquidity, delta);

  const busy = tx.state.status === "signing" || tx.state.status === "pending";
  const disabled =
    busy || parsed === null || parsed === 0n || overWallet || problem !== null;

  async function submit() {
    if (parsed === null) return;

    if (needsApproval) {
      const ok = await tx.send({
        address: pool.assetAddress!,
        abi: erc20Abi,
        functionName: "approve",
        args: [env.poolAddress!, parsed],
      });
      if (!ok) return;
      await allowance.refetch();
    }

    const ok = await tx.send({
      address: env.poolAddress!,
      abi: borrowLiquidityPoolAbi,
      // Both take an amount of the asset, which is what the field holds. The
      // pool's scaled balances are an internal accounting device — a caller
      // never names one.
      functionName: mode === "supply" ? "supply" : "withdraw",
      args: [parsed],
    });

    if (ok) {
      setAmount("");
      pool.refetch();
      void wallet.refetch();
    }
  }

  return (
    <Card>
      <SegmentedControl
        label={t("modeLabel")}
        options={[
          { value: "supply", label: t("supply") },
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
            label={mode === "supply" ? t("amountToSupply") : t("amountToWithdraw")}
            value={amount}
            onChange={setAmount}
            max={max}
            decimals={decimals}
            symbol={symbol}
            maxLabel={mode === "supply" ? t("walletMax") : t("withdrawableMax")}
            disabled={busy}
          />

          <Button
            onClick={submit}
            disabled={disabled}
          >
            {busy
              ? actions("working")
              : needsApproval
                ? t("approveAndSupply")
                : mode === "supply"
                  ? t("supply")
                  : t("withdraw")}
          </Button>

          {overWallet && <p className="text-xs text-negative">{amounts("overWallet")}</p>}
          {problem === "over-balance" && <p className="text-xs text-negative">{t("overBalance")}</p>}
          {problem === "over-liquidity" && (
            <p className="text-xs text-warning">
              {t("overLiquidity", { amount: formatAmount(available, decimals, 2), symbol })}
            </p>
          )}
          <TxStatus tx={tx} />
        </div>

        <div className="flex flex-col gap-3 rounded-sm border border-border bg-raised/40 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-ink-muted">{t("utilizationAfter")}</span>
            <span className="flex items-baseline gap-2">
              {pool.utilization !== undefined && (
                <span className="tabular text-xs text-ink-faint">
                  {formatPercent(pool.utilization)} →
                </span>
              )}
              <span className="tabular text-base font-medium text-ink">
                {preview === null ? "—" : formatPercent(preview)}
              </span>
            </span>
          </div>
          <p className="text-xs leading-relaxed text-ink-muted">
            {mode === "supply" ? t("supplyNote") : t("withdrawNote")}
          </p>
        </div>
      </div>
    </Card>
  );
}

function Line({
  label,
  hint,
  value,
  tone = "default",
}: {
  label: string;
  hint?: string;
  value: string | undefined;
  tone?: "default" | "positive" | "warning";
}) {
  const toneClass =
    tone === "positive" ? "text-positive" : tone === "warning" ? "text-warning" : "text-ink";

  return (
    <div className="flex flex-col gap-1 rounded-sm border border-border bg-raised/30 p-4">
      <Eyebrow as="span">{label}</Eyebrow>
      {value === undefined ? (
        <Skeleton className="h-7 w-24" />
      ) : (
        <span className={`tabular text-2xl font-medium ${toneClass}`}>{value}</span>
      )}
      <span className="text-xs text-ink-faint">{hint ?? " "}</span>
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

