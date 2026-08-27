"use client";

import { useState } from "react";
import { erc20Abi } from "viem";
import { useConnection, useReadContract } from "wagmi";
import { AmountField, TxStatus, parseAmount } from "@/components/AmountField";
import { AppShell, NotConfigured } from "@/components/AppShell";
import { Card, Stat } from "@/components/Card";
import { Faucet } from "@/components/Faucet";
import { Figure } from "@/components/Figure";
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
  const pool = useLendPosition();

  return (
    <AppShell title="Lend" subtitle="Supply the pool that borrowers draw from, and earn what they pay">
      {!poolConfigured ? (
        <NotConfigured what="No lending pool is configured for this network." />
      ) : pool.isError ? (
        <ReadFailed onRetry={pool.refetch} />
      ) : pool.decimals === undefined ? (
        <Loading />
      ) : (
        <LendScreen pool={pool} />
      )}
    </AppShell>
  );
}

function LendScreen({ pool }: { pool: ReturnType<typeof useLendPosition> }) {
  const connection = useConnection();
  const decimals = pool.decimals!;
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

      <Stat label="Your supply" hint="principal + interest">
        <Figure
          value={pool.balance === undefined ? "—" : formatAmount(balance, decimals)}
          unit={symbol}
          size="stat"
          tone={balance === 0n ? "muted" : "default"}
        />
      </Stat>

      <Stat label="Share of the pool" hint="of everything supplied">
        <Figure
          value={pool.balance === undefined ? "—" : formatPercent(share)}
          unit=""
          size="stat"
          tone={balance === 0n ? "muted" : "default"}
        />
      </Stat>

      <Stat label="Withdrawable now" hint="capped by cash on hand">
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
              className="rounded-xl border border-border bg-raised/40 px-4 py-3 text-xs leading-relaxed text-ink-muted"
            >
              {w.text}
            </p>
          ))}
        </div>
      )}

      {connection.status !== "connected" ? (
        <div className="lg:col-span-3">
          <Card className="text-center">
            <h2 className="text-base font-medium text-ink">Connect a wallet to supply</h2>
            <p className="mt-2 text-sm text-ink-muted">
              The pool figures above are the same for everyone. A supply balance is per address.
            </p>
          </Card>
        </div>
      ) : (
        <>
          <div className="lg:col-span-3">
            <Faucet
              assetAddress={pool.assetAddress}
              decimals={decimals}
              symbol={symbol}
              address={connection.address}
              onMinted={pool.refetch}
            />
          </div>
          <div className="lg:col-span-3">
            <SupplyWithdraw pool={pool} address={connection.address} />
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
  const utilization = pool.utilization;
  const kink = pool.kink;
  const strained = utilization !== undefined && kink !== undefined && utilization > kink;

  return (
    <section className="rounded-card border border-border bg-surface p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-ink">The lending pool</h2>
        {pool.borrowRatePerSecond !== undefined && (
          <span className="text-xs text-ink-faint">
            borrowers pay{" "}
            <span className="tabular text-ink">{formatApr(pool.borrowRatePerSecond)}</span>, and
            that is where the supply rate comes from
          </span>
        )}
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Line
          label="Supply rate"
          hint="simple, annualised"
          value={
            pool.supplyRatePerSecond === undefined
              ? undefined
              : formatApr(pool.supplyRatePerSecond)
          }
          tone="positive"
        />
        <Line
          label="Utilization"
          hint={kink === undefined ? undefined : `target ${formatPercent(kink, 0)}`}
          value={utilization === undefined ? undefined : formatPercent(utilization)}
          tone={strained ? "warning" : "default"}
        />
        <Line
          label="Available to withdraw"
          hint="cash in the pool"
          value={
            pool.availableLiquidity === undefined
              ? undefined
              : `${formatAmount(pool.availableLiquidity, decimals, 2)} ${symbol}`
          }
        />
        <Line
          label="Supplied / borrowed"
          hint="all lenders"
          value={
            pool.totalSupplied === undefined || pool.totalBorrowed === undefined
              ? undefined
              : `${formatAmount(pool.totalSupplied, decimals, 0)} / ${formatAmount(pool.totalBorrowed, decimals, 0)}`
          }
        />
      </div>

      {/* The sentence the whole page exists to make sayable. */}
      <p className="mt-5 text-xs leading-relaxed text-ink-muted">
        Utilization is the fraction of the pool that is out on loan. It is what you earn — idle
        liquidity pays nobody — and it is what stands between you and the exit, because money
        that is lent out is not money you can withdraw. The two readings are the whole decision.
      </p>
    </section>
  );
}

function SupplyWithdraw({
  pool,
  address,
}: {
  pool: ReturnType<typeof useLendPosition>;
  address: `0x${string}`;
}) {
  const decimals = pool.decimals!;
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
      <div className="flex items-center gap-1 rounded-lg bg-raised p-1">
        {(["supply", "withdraw"] as const).map((m) => (
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
            label={mode === "supply" ? "Amount to supply" : "Amount to withdraw"}
            value={amount}
            onChange={setAmount}
            max={max}
            decimals={decimals}
            symbol={symbol}
            maxLabel={mode === "supply" ? "Wallet" : "Withdrawable"}
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
                ? "Approve and supply"
                : mode === "supply"
                  ? "Supply"
                  : "Withdraw"}
          </button>

          {overWallet && <p className="text-xs text-negative">More than your wallet holds.</p>}
          {problem === "over-balance" && (
            <p className="text-xs text-negative">More than you have supplied.</p>
          )}
          {problem === "over-liquidity" && (
            <p className="text-xs text-warning">
              More than the pool holds in cash. {formatAmount(available, decimals, 2)} {symbol} is
              available right now — the rest of your balance is out as someone else&rsquo;s loan
              and comes back as borrowers repay.
            </p>
          )}
          <TxStatus state={tx.state} />
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-border bg-raised/40 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-ink-muted">Utilization after</span>
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
            {mode === "supply"
              ? "Supplying lowers utilization, and with it the rate you are about to earn — the curve prices scarcity, so adding liquidity makes it less scarce. The figure above is the rate's input after your deposit lands."
              : "Withdrawing raises utilization for everyone left in the pool, which raises the borrow rate and the supply rate together. Past the target the curve turns steep on purpose."}
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
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-raised/30 p-4">
      <span className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</span>
      {value === undefined ? (
        <div className="h-7 w-24 animate-pulse rounded bg-raised" />
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
          <div className="h-8 w-32 animate-pulse rounded bg-raised" />
        </Card>
      ))}
    </div>
  );
}

function ReadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="mx-auto mt-16 max-w-md text-center">
      <h2 className="text-lg font-semibold text-warning">Could not read the pool</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        The RPC call failed. Any balance you have supplied is unchanged — this screen just cannot
        see it right now.
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
