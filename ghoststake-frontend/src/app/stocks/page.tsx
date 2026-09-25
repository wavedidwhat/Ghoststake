"use client";

import { useState } from "react";
import { erc20Abi } from "viem";
import { AmountField, TxStatus } from "@/components/AmountField";
import { AppShell, NeedsWallet, NotConfigured } from "@/components/AppShell";
import { AssetLogo } from "@/components/AssetLogo";
import { Card, Stat } from "@/components/Card";
import { Faucet } from "@/components/Faucet";
import { Figure } from "@/components/Figure";
import { HealthFactorCard } from "@/components/HealthFactor";
import { useNow } from "@/hooks/useNow";
import { useStockLoan } from "@/hooks/useStockLoan";
import { useTransaction } from "@/hooks/useTransaction";
import { useWallet } from "@/hooks/useWallet";
import { borrowLiquidityPoolAbi, stockLoanVaultAbi } from "@/lib/abis";
import { parseAmount } from "@/lib/amount";
import { env } from "@/lib/env";
import { formatAmount, formatApr, formatDuration, formatHealthFactor, formatPercent, healthBand } from "@/lib/format";
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

const button =
  "cursor-pointer rounded-sm bg-action px-4 py-2.5 text-sm font-medium text-ground transition-colors hover:bg-action-strong focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";

type Loan = ReturnType<typeof useStockLoan>;

export default function StocksPage() {
  const wallet = useWallet();
  const loan = useStockLoan();

  return (
    <AppShell title="Stock loans" subtitle="Borrow dollars against your shares, without selling them">
      {!loan.configured ? (
        <NotConfigured what="Stock loans need tokenized stock, which only Robinhood Chain has. No stock vault is configured for this network." />
      ) : !wallet.isConnected ? (
        <NeedsWallet what="A loan is secured by the stock you deposit." />
      ) : loan.isError ? (
        <Card>
          <p className="text-sm text-negative">Could not read the stock vault. Retrying in a few seconds.</p>
        </Card>
      ) : !loan.ready || loan.stableDecimals === undefined || loan.originationFee === undefined ? (
        <Card>
          <div className="h-24 animate-pulse rounded bg-raised" />
        </Card>
      ) : (
        <StockScreen
          loan={loan}
          decimals={loan.stableDecimals}
          fee={loan.originationFee}
          address={wallet.address}
        />
      )}
    </AppShell>
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
  const now = useNow();
  const [selected, setSelected] = useState(loan.collaterals[0]?.token);
  const chosen = loan.collaterals.find((c) => c.token === selected) ?? loan.collaterals[0];
  const stale = stalePrices(loan.collaterals, now);
  const debt = loan.debt ?? 0n;
  const hasDebt = debt > 0n;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <HealthFactorCard value={loan.healthFactor} liquidatable={loan.healthFactor !== undefined && loan.healthFactor < 10n ** 18n} />
      </div>
      <Stat label="Borrowed" hint="grows every second">
        <Figure value={formatAmount(debt, decimals)} unit={loan.stableSymbol} size="stat" />
      </Stat>
      <Stat label="Collateral value">
        <Figure value={formatAmount(loan.summary.value, decimals)} unit={loan.stableSymbol} size="stat" />
      </Stat>
      <Stat label="Borrow limit" hint="loan may reach this">
        <Figure value={formatAmount(loan.summary.borrowLimit, decimals)} unit={loan.stableSymbol} size="stat" />
      </Stat>
      <Stat label="Liquidation line" hint="loan above this is sold">
        <Figure value={formatAmount(loan.summary.liquidationLine, decimals)} unit={loan.stableSymbol} size="stat" />
      </Stat>

      {loan.summary.incomplete && (
        <div className="lg:col-span-3">
          <Card className="border-negative/40">
            <p className="text-sm text-ink">
              The price of some stock you hold could not be read, so the figures above leave it
              out and understate what your collateral is worth.
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              The vault uses its own price when you sign, so nothing is lent against a number
              shown here. Repaying and withdrawing with no loan still work.
            </p>
          </Card>
        </div>
      )}

      {stale.length > 0 && (
        <div className="lg:col-span-3">
          <Card className="border-warning/40">
            <p className="text-sm text-ink">
              {stale.map((c) => c.symbol).join(", ")} {stale.length === 1 ? "has" : "have"} not traded
              for over {formatDuration(stale[0].maxAge)}, so new borrowing
              {hasDebt ? " and withdrawing" : ""} is paused until the price updates.
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              Normal when the stock market is closed, overnight and at weekends. Repaying always
              works{hasDebt ? "" : ", and so does withdrawing, because you owe nothing"}.
            </p>
          </Card>
        </div>
      )}

      <div className="lg:col-span-3">
        <Card>
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-xs font-medium tracking-wide text-ink-muted uppercase">Your stock</h2>
            <a
              href={ROBINHOOD_FAUCET}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-ink-faint hover:text-action"
            >
              Get test stock from Robinhood&rsquo;s faucet ↗
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
            {c.name} · borrow up to {formatPercent(c.maxLTV, 0)}
          </span>
          {/* The deposit column is hidden on a phone, so what you have in
              the vault still has to be said somewhere in the row. */}
          <span className="tabular block text-xs text-ink-faint sm:hidden">
            {formatAmount(deposited, c.decimals, 4)} deposited · {formatAmount(c.wallet ?? 0n, c.decimals, 4)} in wallet
          </span>
        </span>
        <span className="text-right">
          <span className="tabular block text-sm text-ink">
            {c.valuePerToken === undefined ? "—" : `${formatAmount(c.valuePerToken, decimals, 2)} ${symbol}`}
          </span>
          <span className={`block text-xs ${age !== undefined && age > c.maxAge ? "text-warning" : "text-ink-faint"}`}>
            {age === undefined ? "…" : `price ${formatDuration(age)} old`}
          </span>
        </span>
        <span className="hidden w-56 text-right sm:block">
          <span className="tabular block text-sm text-ink">
            {formatAmount(deposited, c.decimals, 4)} deposited
          </span>
          <span className="tabular block text-xs text-ink-faint">
            {value === undefined ? "" : `${formatAmount(value, decimals, 2)} ${symbol} · `}
            {formatAmount(c.wallet ?? 0n, c.decimals, 4)} in wallet
          </span>
        </span>
      </button>
    </li>
  );
}

function Toggle<T extends string>({
  modes,
  mode,
  onChange,
}: {
  modes: readonly T[];
  mode: T;
  onChange: (m: T) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-sm bg-raised p-1">
      {modes.map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={`flex-1 cursor-pointer rounded-sm px-3 py-2 text-sm font-medium capitalize transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none ${
            mode === m ? "bg-surface text-ink" : "text-ink-muted hover:text-ink"
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function CollateralPanel({ loan, c, blocked }: { loan: Loan; c: StockCollateral; blocked: boolean }) {
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
          <h2 className="text-sm font-medium text-ink">{c.symbol} collateral</h2>
          <p className="text-xs text-ink-muted">
            Liquidated past {formatPercent(c.liquidationThreshold, 0)} of its value, at a{" "}
            {formatPercent(c.liquidationBonus, 0)} discount to the liquidator.
          </p>
        </div>
      </div>
      <div className="mt-4">
        <Toggle
          modes={["deposit", "withdraw"] as const}
          mode={mode}
          onChange={(m) => {
            setMode(m);
            setAmount("");
            tx.reset();
          }}
        />
      </div>
      <div className="mt-4 flex flex-col gap-4">
        <AmountField
          label={mode === "deposit" ? "Amount to deposit" : "Amount to withdraw"}
          value={amount}
          onChange={setAmount}
          max={max}
          decimals={c.decimals}
          symbol={c.symbol}
          maxLabel={mode === "deposit" ? "Wallet" : loan.debt ? "Free" : "Deposited"}
          disabled={busy}
        />
        <button onClick={submit} disabled={disabled} className={button}>
          {busy ? "Working…" : needsApproval ? `Approve and deposit` : mode === "deposit" ? "Deposit" : "Withdraw"}
        </button>
        {overMax && (
          <p className="text-xs text-negative">
            {mode === "deposit" ? "More than your wallet holds." : "Your loan needs this much to stay within its limit."}
          </p>
        )}
        {mode === "withdraw" && blocked && (
          <p className="text-xs text-warning">Paused while a price is stale, because you have a loan.</p>
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
      <h2 className="text-sm font-medium text-ink">Your loan</h2>
      <p className="text-xs text-ink-muted">
        {loan.borrowRate === undefined ? "" : `${formatApr(loan.borrowRate)} a year, `}
        plus a one-off {formatPercent(fee, 1)} fee on each borrow.
      </p>
      <div className="mt-4">
        <Toggle
          modes={["borrow", "repay"] as const}
          mode={mode}
          onChange={(m) => {
            setMode(m);
            setAmount("");
            tx.reset();
          }}
        />
      </div>
      <div className="mt-4 flex flex-col gap-4">
        <AmountField
          label={mode === "borrow" ? "Amount to receive" : "Amount to repay"}
          value={amount}
          onChange={setAmount}
          max={max}
          decimals={decimals}
          symbol={loan.stableSymbol}
          maxLabel={mode === "borrow" ? "Capacity" : "Owed"}
          disabled={busy}
        />
        <div className="flex flex-col gap-1.5 rounded-sm border border-border bg-raised/40 p-3 text-xs">
          {mode === "borrow" && (
            <div className="flex justify-between gap-3">
              <span className="text-ink-muted">Fee, added to your loan</span>
              <span className="tabular text-ink">
                {formatAmount(feeDue, decimals, 2)} {loan.stableSymbol}
              </span>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <span className="text-ink-muted">Loan after</span>
            <span className="tabular text-ink">
              {formatAmount(debtAfter > 0n ? debtAfter : 0n, decimals, 2)} {loan.stableSymbol}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-ink-muted">Health factor after</span>
            <span className={`tabular ${preview === null ? "text-ink-muted" : toneOf(preview)}`}>
              {preview === null ? "no loan" : (formatHealthFactor(preview) ?? "—")}
            </span>
          </div>
        </div>
        <button onClick={submit} disabled={disabled} className={button}>
          {busy ? "Working…" : needsApproval ? "Approve and repay" : mode === "borrow" ? "Borrow" : "Repay"}
        </button>
        {mode === "borrow" && blocked && (
          <p className="text-xs text-warning">Paused until the stale price updates.</p>
        )}
        {overMax && (
          <p className="text-xs text-negative">
            {mode === "borrow"
              ? borrowMax > liquidity
                ? "More than the pool has available to lend."
                : "Above your borrow limit, once the fee is added."
              : "More than you owe."}
          </p>
        )}
        {overWallet && <p className="text-xs text-negative">More than your wallet holds.</p>}
        <TxStatus tx={tx} />
      </div>
    </Card>
  );
}

function LendPanel({ loan, decimals, address }: { loan: Loan; decimals: number; address: `0x${string}` }) {
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
          <h2 className="text-sm font-medium text-ink">Lend to stock borrowers</h2>
          <p className="text-xs text-ink-muted">
            {loan.supplyRate === undefined ? "" : `Earning ${formatApr(loan.supplyRate)} a year now. `}
            If a loan goes bad, its stock is sold and the proceeds come back here; any shortfall is
            paid from the platform&rsquo;s reserves first, then by lenders.
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Toggle
            modes={["supply", "withdraw"] as const}
            mode={mode}
            onChange={(m) => {
              setMode(m);
              setAmount("");
              tx.reset();
            }}
          />
          <AmountField
            label={mode === "supply" ? "Amount to lend" : "Amount to withdraw"}
            value={amount}
            onChange={setAmount}
            max={max}
            decimals={decimals}
            symbol={loan.stableSymbol}
            maxLabel={mode === "supply" ? "Wallet" : "Available"}
            disabled={busy}
          />
          <button onClick={submit} disabled={disabled} className={button}>
            {busy ? "Working…" : needsApproval ? "Approve and lend" : mode === "supply" ? "Lend" : "Withdraw"}
          </button>
          {overMax && (
            <p className="text-xs text-negative">
              {mode === "supply" ? "More than your wallet holds." : "More than is free to withdraw right now."}
            </p>
          )}
          <TxStatus tx={tx} />
        </div>
        <div className="flex flex-col gap-3">
          <Stat label="You have lent">
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
