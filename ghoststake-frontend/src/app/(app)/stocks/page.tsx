"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { erc20Abi } from "viem";
import { AmountField, TxStatus } from "@/components/AmountField";
import { Page, NeedsWallet, NotConfigured } from "@/components/Page";
import { AssetLogo } from "@/components/ui/AssetLogo";
import { Card, Stat } from "@/components/ui/Card";
import { Faucet } from "@/components/Faucet";
import { Figure } from "@/components/ui/Figure";
import { Button } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import { HealthFactorCard } from "@/components/HealthFactor";
import { useNow } from "@/hooks/useNow";
import { useStockLoan } from "@/hooks/useStockLoan";
import { useVaultAsset } from "@/hooks/useVaultPosition";
import { useTransaction } from "@/hooks/useTransaction";
import { useWallet } from "@/hooks/useWallet";
import { borrowLiquidityPoolAbi, stockLoanVaultAbi } from "@/lib/abis";
import { parseAmount } from "@/lib/amount";
import { env } from "@/lib/env";
import { healthBand } from "@/lib/format";
import { useFormat } from "@/i18n/useFormat";
import {
  healthAfter,
  maxBorrow,
  maxWithdraw,
  originationFeeOn,
  priceAge,
  stalePrices,
  valueOfAmount,
  type StockCollateral,
} from "@/lib/stockLoan";

const ROBINHOOD_FAUCET = "https://faucet.testnet.chain.robinhood.com";

type Loan = ReturnType<typeof useStockLoan>;

export default function StocksPage() {
  const t = useTranslations("stocks");
  const wallet = useWallet();
  const loan = useStockLoan();

  return (
    <Page title={t("title")} subtitle={t("subtitle")}>
      {!loan.configured ? (
        <NotConfigured what={t("notConfigured")} />
      ) : !wallet.isConnected ? (
        <NeedsWallet what={t("needsWallet")} />
      ) : loan.isError ? (
        <Card>
          <p className="text-sm text-negative">{t("unreadable")}</p>
        </Card>
      ) : !loan.ready || loan.stableDecimals === undefined || loan.originationFee === undefined ? (
        <Card>
          <Skeleton className="h-24" />
        </Card>
      ) : (
        <StockScreen
          loan={loan}
          decimals={loan.stableDecimals}
          fee={loan.originationFee}
          address={wallet.address}
        />
      )}
    </Page>
  );
}

function StockScreen({
  loan,
  decimals,
  fee,
  address,
}: {
  loan: Loan;
  decimals: number;
  fee: bigint;
  address: `0x${string}`;
}) {
  const { formatAmount, formatDuration } = useFormat();
  const t = useTranslations("stocks");
  const now = useNow();
  const [selected, setSelected] = useState(loan.collaterals[0]?.token);
  const chosen = loan.collaterals.find((c) => c.token === selected) ?? loan.collaterals[0];
  const stale = stalePrices(loan.collaterals, now);
  const debt = loan.debt ?? 0n;
  const hasDebt = debt > 0n;
  // Money borrowed here is meant to back rounds, which only take the
  // deposit vault's asset. The first deploy paid out a second token also
  // called mUSDC, so a borrower saw 300 here and 0 on the market (GHO-125).
  // The deploy now refuses that; this says so if it ever happens anyway.
  const marketToken = useVaultAsset().address;
  const otherToken =
    marketToken !== undefined && loan.stable !== undefined && marketToken.toLowerCase() !== loan.stable.toLowerCase();

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {otherToken && (
        <div className="lg:col-span-3">
          <Card className="border-negative/40">
            <p className="text-sm text-ink">{t("otherToken", { symbol: loan.stableSymbol })}</p>
          </Card>
        </div>
      )}
      <div className="lg:col-span-2">
        <HealthFactorCard value={loan.healthFactor} liquidatable={loan.healthFactor !== undefined && loan.healthFactor < 10n ** 18n} />
      </div>
      <Stat label={t("borrowed")} hint={t("borrowedHint")}>
        <Figure value={formatAmount(debt, decimals)} unit={loan.stableSymbol} size="stat" />
      </Stat>
      <Stat label={t("collateralValue")}>
        <Figure value={formatAmount(loan.summary.value, decimals)} unit={loan.stableSymbol} size="stat" />
      </Stat>
      <Stat label={t("borrowLimit")} hint={t("borrowLimitHint")}>
        <Figure value={formatAmount(loan.summary.borrowLimit, decimals)} unit={loan.stableSymbol} size="stat" />
      </Stat>
      <Stat label={t("liquidationLine")} hint={t("liquidationLineHint")}>
        <Figure value={formatAmount(loan.summary.liquidationLine, decimals)} unit={loan.stableSymbol} size="stat" />
      </Stat>

      {loan.summary.incomplete && (
        <div className="lg:col-span-3">
          <Card className="border-negative/40">
            <p className="text-sm text-ink">{t("incomplete")}</p>
            <p className="mt-1 text-xs text-ink-muted">{t("incompleteDetail")}</p>
          </Card>
        </div>
      )}

      {stale.length > 0 && (
        <div className="lg:col-span-3">
          <Card className="border-warning/40">
            <p className="text-sm text-ink">
              {t("stale", {
                symbols: stale.map((c) => c.symbol).join(", "),
                count: stale.length,
                duration: formatDuration(stale[0].maxAge),
                debt: hasDebt ? "yes" : "no",
              })}
            </p>
            <p className="mt-1 text-xs text-ink-muted">{t("staleDetail", { debt: hasDebt ? "yes" : "no" })}</p>
          </Card>
        </div>
      )}

      <div className="lg:col-span-3">
        <Card>
          <div className="flex items-baseline justify-between gap-2">
            <Eyebrow as="h2">{t("yourStock")}</Eyebrow>
            <a
              href={ROBINHOOD_FAUCET}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-ink-faint hover:text-action"
            >
              {t("faucet")}
            </a>
          </div>
          <ul className="mt-3 divide-y divide-border">
            {loan.collaterals.map((c) => (
              <CollateralRow
                key={c.token}
                c={c}
                decimals={decimals}
                symbol={loan.stableSymbol}
                now={now}
                selected={c.token === chosen?.token}
                onSelect={() => setSelected(c.token)}
              />
            ))}
          </ul>
        </Card>
      </div>

      <div className="lg:col-span-3 grid gap-4 md:grid-cols-2">
        {chosen && <CollateralPanel key={chosen.token} loan={loan} c={chosen} blocked={hasDebt && stale.length > 0} />}
        <LoanPanel loan={loan} decimals={decimals} fee={fee} address={address} blocked={stale.length > 0} />
      </div>

      <div className="lg:col-span-3">
        <LendPanel loan={loan} decimals={decimals} address={address} />
      </div>
    </div>
  );
}

function CollateralRow({
  c,
  decimals,
  symbol,
  now,
  selected,
  onSelect,
}: {
  c: StockCollateral;
  decimals: number;
  symbol: string;
  now: bigint | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const { formatAmount, formatDuration, formatPercent } = useFormat();
  const t = useTranslations("stocks");
  const age = priceAge(c, now);
  const deposited = c.deposited ?? 0n;
  const value = valueOfAmount(c, deposited);

  return (
    <li>
      <button
        onClick={onSelect}
        aria-pressed={selected}
        className={`flex w-full cursor-pointer items-center gap-3 rounded-sm px-2 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none ${
          selected ? "bg-raised" : "hover:bg-raised/50"
        }`}
      >
        <AssetLogo symbol={c.symbol} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">{c.symbol}</span>
          <span className="block truncate text-xs text-ink-muted">
            {t("borrowUpTo", { name: c.name, ltv: formatPercent(c.maxLTV, 0) })}
          </span>
          {/* The deposit column is hidden on a phone, so what you have in
              the vault still has to be said somewhere in the row. */}
          <span className="tabular block text-xs text-ink-faint sm:hidden">
            {t("depositedInWallet", {
              deposited: formatAmount(deposited, c.decimals, 4),
              wallet: formatAmount(c.wallet ?? 0n, c.decimals, 4),
            })}
          </span>
        </span>
        <span className="text-right">
          <span className="tabular block text-sm text-ink">
            {c.valuePerToken === undefined ? "—" : `${formatAmount(c.valuePerToken, decimals, 2)} ${symbol}`}
          </span>
          <span className={`block text-xs ${age !== undefined && age > c.maxAge ? "text-warning" : "text-ink-faint"}`}>
            {age === undefined ? "…" : t("priceAge", { age: formatDuration(age) })}
          </span>
        </span>
        <span className="hidden w-56 text-right sm:block">
          <span className="tabular block text-sm text-ink">
            {t("deposited", { amount: formatAmount(deposited, c.decimals, 4) })}
          </span>
          <span className="tabular block text-xs text-ink-faint">
            {value === undefined
              ? t("inWallet", { amount: formatAmount(c.wallet ?? 0n, c.decimals, 4) })
              : t("valueInWallet", {
                  value: formatAmount(value, decimals, 2),
                  symbol,
                  amount: formatAmount(c.wallet ?? 0n, c.decimals, 4),
                })}
          </span>
        </span>
      </button>
    </li>
  );
}

function CollateralPanel({ loan, c, blocked }: { loan: Loan; c: StockCollateral; blocked: boolean }) {
  const { formatPercent } = useFormat();
  const t = useTranslations("stocks");
  const actions = useTranslations("actions");
  const amounts = useTranslations("amount");
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const tx = useTransaction();

  const parsed = parseAmount(amount, c.decimals);
  const max = mode === "deposit" ? c.wallet : maxWithdraw(c, loan.summary, loan.debt);
  const overMax = parsed !== null && max !== undefined && parsed > max;
  const needsApproval = mode === "deposit" && parsed !== null && (c.allowance ?? 0n) < parsed;
  const busy = tx.state.status === "signing" || tx.state.status === "pending";
  const disabled = busy || parsed === null || parsed === 0n || overMax || (mode === "withdraw" && blocked);

  async function submit() {
    if (parsed === null) return;
    if (needsApproval) {
      const ok = await tx.send({
        address: c.token,
        abi: erc20Abi,
        functionName: "approve",
        args: [env.stockVaultAddress!, parsed],
      });
      if (!ok) return;
    }
    const ok = await tx.send({
      address: env.stockVaultAddress!,
      abi: stockLoanVaultAbi,
      functionName: mode,
      args: [c.token, parsed],
    });
    if (ok) {
      setAmount("");
      void loan.refetch();
    }
  }

  return (
    <Card>
      <div className="flex items-center gap-3">
        <AssetLogo symbol={c.symbol} size="lg" />
        <div>
          <h2 className="text-sm font-medium text-ink">{t("collateralTitle", { symbol: c.symbol })}</h2>
          <p className="text-xs text-ink-muted">
            {t("collateralTerms", {
              threshold: formatPercent(c.liquidationThreshold, 0),
              bonus: formatPercent(c.liquidationBonus, 0),
            })}
          </p>
        </div>
      </div>
      <div className="mt-4">
        <SegmentedControl
          label={t("collateralModeLabel")}
          options={[{ value: "deposit", label: t("deposit") }, { value: "withdraw", label: t("withdraw") }] as const}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setAmount("");
            tx.reset();
          }}
        />
      </div>
      <div className="mt-4 flex flex-col gap-4">
        <AmountField
          label={mode === "deposit" ? t("amountToDeposit") : t("amountToWithdraw")}
          value={amount}
          onChange={setAmount}
          max={max}
          decimals={c.decimals}
          symbol={c.symbol}
          maxLabel={mode === "deposit" ? t("walletMax") : loan.debt ? t("freeMax") : t("depositedMax")}
          disabled={busy}
        />
        <Button onClick={submit} disabled={disabled}>
          {busy
            ? actions("working")
            : needsApproval
              ? t("approveAndDeposit")
              : mode === "deposit"
                ? t("deposit")
                : t("withdraw")}
        </Button>
        {overMax && (
          <p className="text-xs text-negative">
            {mode === "deposit" ? amounts("overWallet") : t("loanNeedsIt")}
          </p>
        )}
        {mode === "withdraw" && blocked && (
          <p className="text-xs text-warning">{t("withdrawPaused")}</p>
        )}
        <TxStatus tx={tx} />
      </div>
    </Card>
  );
}

function LoanPanel({
  loan,
  decimals,
  fee,
  address,
  blocked,
}: {
  loan: Loan;
  decimals: number;
  fee: bigint;
  address: `0x${string}`;
  blocked: boolean;
}) {
  const { formatAmount, formatApr, formatHealthFactor, formatPercent } = useFormat();
  const t = useTranslations("stocks");
  const vault = useTranslations("vault");
  const actions = useTranslations("actions");
  const amounts = useTranslations("amount");
  const [mode, setMode] = useState<"borrow" | "repay">("borrow");
  const [amount, setAmount] = useState("");
  const tx = useTransaction();

  const debt = loan.debt ?? 0n;
  const parsed = parseAmount(amount, decimals);
  const borrowMax = maxBorrow(loan.summary.borrowLimit, debt, fee);
  const liquidity = loan.liquidity ?? 0n;
  const max = mode === "borrow" ? (borrowMax < liquidity ? borrowMax : liquidity) : debt;
  const overMax = parsed !== null && parsed > max;
  const overWallet = mode === "repay" && parsed !== null && parsed > (loan.stableWallet ?? 0n);
  const busy = tx.state.status === "signing" || tx.state.status === "pending";
  const disabled =
    busy || parsed === null || parsed === 0n || overMax || overWallet || (mode === "borrow" && blocked);

  const feeDue = mode === "borrow" && parsed ? originationFeeOn(parsed, fee) : 0n;
  const debtAfter = mode === "borrow" ? debt + (parsed ?? 0n) + feeDue : debt - (parsed ?? 0n);
  const preview = healthAfter(loan.summary, debtAfter);

  // Interest accrues between reading the debt and the repay being mined, so a
  // repay of exactly the debt read leaves dust behind (it did, on chain, by
  // 8 millionths of a dollar). Paying the whole debt sends a little more; the
  // vault caps a repayment at what is owed and takes only that.
  const repayingAll = mode === "repay" && parsed !== null && parsed >= debt && debt > 0n;
  const wallet = loan.stableWallet ?? 0n;
  const buffered = debt + debt / 1000n + 1n;
  const toSend = repayingAll ? (buffered < wallet ? buffered : wallet) : (parsed ?? 0n);
  const needsApproval = mode === "repay" && (loan.stableAllowanceVault ?? 0n) < toSend;

  async function submit() {
    if (parsed === null) return;
    if (needsApproval) {
      const ok = await tx.send({
        address: loan.stable!,
        abi: erc20Abi,
        functionName: "approve",
        args: [env.stockVaultAddress!, toSend],
      });
      if (!ok) return;
    }
    const ok = await tx.send(
      mode === "borrow"
        ? { address: env.stockVaultAddress!, abi: stockLoanVaultAbi, functionName: "borrow", args: [parsed] }
        : { address: env.stockVaultAddress!, abi: stockLoanVaultAbi, functionName: "repay", args: [toSend, address] },
    );
    if (ok) {
      setAmount("");
      void loan.refetch();
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-medium text-ink">{t("yourLoan")}</h2>
      <p className="text-xs text-ink-muted">
        {loan.borrowRate === undefined
          ? t("loanTerms", { fee: formatPercent(fee, 1) })
          : t("loanTermsRate", { rate: formatApr(loan.borrowRate), fee: formatPercent(fee, 1) })}
      </p>
      <div className="mt-4">
        <SegmentedControl
          label={t("loanModeLabel")}
          options={[{ value: "borrow", label: t("borrow") }, { value: "repay", label: t("repay") }] as const}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setAmount("");
            tx.reset();
          }}
        />
      </div>
      <div className="mt-4 flex flex-col gap-4">
        <AmountField
          label={mode === "borrow" ? t("amountToReceive") : t("amountToRepay")}
          value={amount}
          onChange={setAmount}
          max={max}
          decimals={decimals}
          symbol={loan.stableSymbol}
          maxLabel={mode === "borrow" ? t("capacityMax") : t("owedMax")}
          disabled={busy}
        />
        <div className="flex flex-col gap-1.5 rounded-sm border border-border bg-raised/40 p-3 text-xs">
          {mode === "borrow" && (
            <div className="flex justify-between gap-3">
              <span className="text-ink-muted">{t("feeAdded")}</span>
              <span className="tabular text-ink">
                {formatAmount(feeDue, decimals, 2)} {loan.stableSymbol}
              </span>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <span className="text-ink-muted">{t("loanAfter")}</span>
            <span className="tabular text-ink">
              {formatAmount(debtAfter > 0n ? debtAfter : 0n, decimals, 2)} {loan.stableSymbol}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-ink-muted">{vault("healthAfter")}</span>
            <span className={`tabular ${preview === null ? "text-ink-muted" : toneOf(preview)}`}>
              {preview === null ? t("noLoan") : (formatHealthFactor(preview) ?? "—")}
            </span>
          </div>
        </div>
        <Button onClick={submit} disabled={disabled}>
          {busy
            ? actions("working")
            : needsApproval
              ? t("approveAndRepay")
              : mode === "borrow"
                ? t("borrow")
                : t("repay")}
        </Button>
        {mode === "borrow" && blocked && (
          <p className="text-xs text-warning">{t("borrowPaused")}</p>
        )}
        {overMax && (
          <p className="text-xs text-negative">
            {mode === "borrow"
              ? borrowMax > liquidity
                ? t("overPool")
                : t("overLimit")
              : t("overDebt")}
          </p>
        )}
        {overWallet && <p className="text-xs text-negative">{amounts("overWallet")}</p>}
        <TxStatus tx={tx} />
      </div>
    </Card>
  );
}

function LendPanel({ loan, decimals, address }: { loan: Loan; decimals: number; address: `0x${string}` }) {
  const { formatAmount, formatApr } = useFormat();
  const t = useTranslations("stocks");
  const actions = useTranslations("actions");
  const amounts = useTranslations("amount");
  const [mode, setMode] = useState<"supply" | "withdraw">("supply");
  const [amount, setAmount] = useState("");
  const tx = useTransaction();

  const parsed = parseAmount(amount, decimals);
  const supplied = loan.supplied ?? 0n;
  const liquidity = loan.liquidity ?? 0n;
  const max = mode === "supply" ? loan.stableWallet : supplied < liquidity ? supplied : liquidity;
  const overMax = parsed !== null && max !== undefined && parsed > max;
  const needsApproval = mode === "supply" && parsed !== null && (loan.stableAllowancePool ?? 0n) < parsed;
  const busy = tx.state.status === "signing" || tx.state.status === "pending";
  const disabled = busy || parsed === null || parsed === 0n || overMax;

  async function submit() {
    if (parsed === null) return;
    if (needsApproval) {
      const ok = await tx.send({
        address: loan.stable!,
        abi: erc20Abi,
        functionName: "approve",
        args: [loan.pool!, parsed],
      });
      if (!ok) return;
    }
    const ok = await tx.send({
      address: loan.pool!,
      abi: borrowLiquidityPoolAbi,
      functionName: mode,
      args: [parsed],
    });
    if (ok) {
      setAmount("");
      void loan.refetch();
    }
  }

  return (
    <Card>
      <div className="flex items-center gap-3">
        <AssetLogo symbol={loan.stableSymbol} size="lg" />
        <div>
          <h2 className="text-sm font-medium text-ink">{t("lendTitle")}</h2>
          <p className="text-xs text-ink-muted">
            {loan.supplyRate === undefined
              ? t("lendTerms")
              : t("lendTermsRate", { rate: formatApr(loan.supplyRate) })}
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <SegmentedControl
            label={t("lendModeLabel")}
            options={[{ value: "supply", label: t("lend") }, { value: "withdraw", label: t("withdraw") }] as const}
            value={mode}
            onChange={(m) => {
              setMode(m);
              setAmount("");
              tx.reset();
            }}
          />
          <AmountField
            label={mode === "supply" ? t("amountToLend") : t("amountToWithdraw")}
            value={amount}
            onChange={setAmount}
            max={max}
            decimals={decimals}
            symbol={loan.stableSymbol}
            maxLabel={mode === "supply" ? t("walletMax") : t("availableMax")}
            disabled={busy}
          />
          <Button onClick={submit} disabled={disabled}>
            {busy
              ? actions("working")
              : needsApproval
                ? t("approveAndLend")
                : mode === "supply"
                  ? t("lend")
                  : t("withdraw")}
          </Button>
          {overMax && (
            <p className="text-xs text-negative">
              {mode === "supply" ? amounts("overWallet") : t("overFree")}
            </p>
          )}
          <TxStatus tx={tx} />
        </div>
        <div className="flex flex-col gap-3">
          <Stat label={t("youHaveLent")}>
            <Figure value={formatAmount(supplied, decimals)} unit={loan.stableSymbol} size="stat" />
          </Stat>
          <Faucet
            assetAddress={loan.stable}
            decimals={decimals}
            symbol={loan.stableSymbol}
            address={address}
            onMinted={() => void loan.refetch()}
          />
        </div>
      </div>
    </Card>
  );
}

function toneOf(preview: bigint): string {
  const band = healthBand(preview);
  return band === "danger" ? "text-negative" : band === "caution" ? "text-warning" : "text-positive";
}
