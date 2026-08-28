"use client";

import { useState } from "react";
import { useReadContracts } from "wagmi";
import { AmountField, TxStatus, parseAmount } from "@/components/AmountField";
import { Card } from "@/components/Card";
import { useTransaction } from "@/hooks/useTransaction";
import { borrowLiquidityPoolAbi, parimutuelRoundAbi } from "@/lib/abis";
import { env, poolConfigured } from "@/lib/env";
import { formatAmount, shortenAddress } from "@/lib/format";
import type { Market } from "@/lib/markets";
import { activeChain } from "@/lib/wagmi";

/**
 * Where the protocol's earnings are, and how they leave.
 *
 * The protocol earns in two places — the round rake in `protocolFees`, and the
 * lending reserve factor in `totalReserves` — and until GHO-40 neither was
 * reachable without a terminal. Sepolia was holding 0.8 mUSDC of rake from a
 * settled round with nothing in the app saying so, and `cast send` as the only
 * way to move it.
 *
 * Two things are surfaced beyond the balances, and both are the point:
 *
 * **The destination, before signing.** `withdrawFees` used to take a `to`
 * parameter validated only as non-zero, so where the money went was decided
 * inside the transaction that moved it. It now goes to `treasury`, and the
 * panel names the address it is about to go to.
 *
 * **The bound.** `withdrawFees` is capped by `protocolFees` and not by the
 * token balance, which means the owner provably cannot reach stakes still owed
 * to users — including a resolved round's unclaimed winnings. That is a real
 * property of the contract and it lived only in a code comment.
 */
export function FeesPanel({
  markets,
  address,
  decimals,
  symbol,
}: {
  markets: Market[];
  address: `0x${string}`;
  decimals: number | undefined;
  symbol: string;
}) {
  return (
    <section aria-labelledby="fees-heading" className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h2 id="fees-heading" className="text-xs font-medium tracking-wide text-ink-muted uppercase">
          Protocol earnings
        </h2>
        <span className="h-px flex-1 bg-border" />
      </div>

      {markets.map((market) => (
        <MarketFees
          key={market.key}
          market={market}
          address={address}
          decimals={decimals}
          symbol={symbol}
        />
      ))}

      {poolConfigured && <PoolReserves address={address} decimals={decimals} symbol={symbol} />}
    </section>
  );
}

function MarketFees({
  market,
  address,
  decimals,
  symbol,
}: {
  market: Market;
  address: `0x${string}`;
  decimals: number | undefined;
  symbol: string;
}) {
  const query = useReadContracts({
    contracts: [
      { address: market.address, abi: parimutuelRoundAbi, functionName: "protocolFees", chainId: activeChain.id },
      { address: market.address, abi: parimutuelRoundAbi, functionName: "treasury", chainId: activeChain.id },
      { address: market.address, abi: parimutuelRoundAbi, functionName: "owner", chainId: activeChain.id },
    ],
    query: { refetchInterval: 12_000 },
  });
  const [fees, treasury, owner] = query.data ?? [];

  return (
    <Balance
      title={`Round rake — ${shortenAddress(market.address)}`}
      predatesTreasury={treasury?.status === "failure"}
      note="Taken from the losing pool at settlement. A voided round takes none at all — rake is only recorded on the resolve path — so a market on a slow feed earns nothing while it is voiding."
      bound="Capped by the rake collected, not by the token balance, so this cannot reach stakes still owed to users — including a resolved round's unclaimed winnings."
      balance={fees?.result as bigint | undefined}
      treasury={treasury?.result as `0x${string}` | undefined}
      owner={owner?.result as `0x${string}` | undefined}
      address={address}
      decimals={decimals}
      symbol={symbol}
      contract={market.address}
      abi={parimutuelRoundAbi}
      withdrawFn="withdrawFees"
      onDone={() => void query.refetch()}
    />
  );
}

function PoolReserves({
  address,
  decimals,
  symbol,
}: {
  address: `0x${string}`;
  decimals: number | undefined;
  symbol: string;
}) {
  const query = useReadContracts({
    contracts: [
      { address: env.poolAddress!, abi: borrowLiquidityPoolAbi, functionName: "totalReserves", chainId: activeChain.id },
      { address: env.poolAddress!, abi: borrowLiquidityPoolAbi, functionName: "treasury", chainId: activeChain.id },
      { address: env.poolAddress!, abi: borrowLiquidityPoolAbi, functionName: "owner", chainId: activeChain.id },
    ],
    query: { refetchInterval: 12_000 },
  });
  const [reserves, treasury, owner] = query.data ?? [];

  return (
    <Balance
      title="Lending reserves"
      predatesTreasury={treasury?.status === "failure"}
      note="The protocol's cut of borrower interest, credited when interest accrues into the index rather than when a borrower pays."
      bound="Subordinated to suppliers: a withdrawal is refused unless the pool still holds enough cash to meet every supplier claim afterwards. Credited interest that nobody has paid is not withdrawable."
      balance={reserves?.result as bigint | undefined}
      treasury={treasury?.result as `0x${string}` | undefined}
      owner={owner?.result as `0x${string}` | undefined}
      address={address}
      decimals={decimals}
      symbol={symbol}
      contract={env.poolAddress!}
      abi={borrowLiquidityPoolAbi}
      withdrawFn="withdrawReserves"
      onDone={() => void query.refetch()}
    />
  );
}

/**
 * One balance, its destination, and the two writes that touch it.
 *
 * Shared between the rake and the reserves because they are the same shape:
 * an owner-only withdrawal to a stored treasury, bounded by something narrower
 * than the token balance. The `bound` prop is what differs, and it is prose
 * rather than a number because the two bounds are genuinely different rules.
 */
function Balance({
  title,
  note,
  bound,
  balance,
  predatesTreasury,
  treasury,
  owner,
  address,
  decimals,
  symbol,
  contract,
  abi,
  withdrawFn,
  onDone,
}: {
  title: string;
  note: string;
  bound: string;
  balance: bigint | undefined;
  /** The read reverted, which on a live chain means one thing: this contract
   *  was deployed before `Treasured` existed and still takes a destination
   *  parameter. Distinguished from "still loading" because the two look
   *  identical and mean opposite things — the same distinction the rest of
   *  this app makes between an empty position and an unreadable one. */
  predatesTreasury: boolean;
  treasury: `0x${string}` | undefined;
  owner: `0x${string}` | undefined;
  address: `0x${string}`;
  decimals: number | undefined;
  symbol: string;
  contract: `0x${string}`;
  abi: typeof parimutuelRoundAbi | typeof borrowLiquidityPoolAbi;
  withdrawFn: "withdrawFees" | "withdrawReserves";
  onDone: () => void;
}) {
  const withdraw = useTransaction();
  const repoint = useTransaction();
  const [amount, setAmount] = useState("");
  const [nextTreasury, setNextTreasury] = useState("");
  const [repointing, setRepointing] = useState(false);

  const isOwner = owner !== undefined && address.toLowerCase() === owner.toLowerCase();
  // `parseAmount` returns null for an unparseable or over-precise input, and
  // undefined here means decimals have not loaded. Both block the button; they
  // are folded together because nothing downstream needs to tell them apart.
  const parsed = decimals === undefined ? null : parseAmount(amount, decimals);
  const busy = withdraw.state.status === "signing" || withdraw.state.status === "pending";
  // Bounded by the accrued figure rather than only by what the user typed:
  // the contract will refuse anything over it, and finding that out from a
  // reverted transaction costs gas to learn something the page already knows.
  const overBalance = parsed !== null && balance !== undefined && parsed > balance;

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        {balance === undefined || decimals === undefined ? (
          <span className="h-6 w-24 animate-pulse rounded bg-raised" />
        ) : (
          <span className="tabular text-base font-medium text-ink">
            {formatAmount(balance, decimals, 4)} {symbol}
          </span>
        )}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-ink-faint">{note}</p>
      <p className="mt-2 text-xs leading-relaxed text-ink-muted">{bound}</p>

      {/* Stated before anything is signed, and stated as an address rather
          than as "the treasury" — the word is not the thing, and the whole
          point of GHO-40 is that the destination should be knowable in
          advance. */}
      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 rounded-xl border border-border bg-raised/40 px-4 py-3">
        {predatesTreasury ? (
          <span className="text-xs text-warning">
            This contract was deployed before the stored treasury and has no{" "}
            <code>treasury()</code>. Its withdrawal still takes a destination, so it can only be
            called from a terminal — that is the state GHO-40 is about, and it clears on the next
            deploy.
          </span>
        ) : (
          <>
            <span className="text-xs text-ink-muted">
              Goes to{" "}
              {treasury === undefined ? (
                <span className="text-ink-faint">reading…</span>
              ) : (
                <code className="text-ink">{treasury}</code>
              )}
            </span>
            {isOwner && (
              <button
                onClick={() => setRepointing((v) => !v)}
                className="cursor-pointer text-xs text-ink-faint underline-offset-2 hover:text-ink hover:underline"
              >
                {repointing ? "Cancel" : "Change"}
              </button>
            )}
          </>
        )}
      </div>

      {repointing && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={nextTreasury}
            onChange={(e) => setNextTreasury(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-border bg-ground px-3 py-1.5 font-mono text-xs text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          />
          <button
            disabled={!/^0x[0-9a-fA-F]{40}$/.test(nextTreasury.trim())}
            onClick={async () => {
              const ok = await repoint.send({
                address: contract,
                abi,
                functionName: "setTreasury",
                args: [nextTreasury.trim() as `0x${string}`],
              });
              if (ok) {
                setRepointing(false);
                setNextTreasury("");
                onDone();
              }
            }}
            className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-xs text-ink transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            Set destination
          </button>
          <TxStatus state={repoint.state} />
        </div>
      )}

      {balance !== undefined && balance > 0n && decimals !== undefined && !predatesTreasury && (
        <div className="mt-4 flex flex-col gap-2">
          <AmountField
            label="Withdraw"
            value={amount}
            onChange={setAmount}
            decimals={decimals}
            symbol={symbol}
            max={balance}
          />
          {overBalance && (
            <p className="text-xs text-negative">
              More than has accrued. The contract would refuse this.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              disabled={busy || !isOwner || parsed === null || parsed === 0n || overBalance}
              onClick={async () => {
                const ok = await withdraw.send({
                  address: contract,
                  abi,
                  functionName: withdrawFn,
                  args: [parsed!],
                });
                if (ok) {
                  setAmount("");
                  onDone();
                }
              }}
              className="cursor-pointer rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-ground transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Working…" : "Withdraw"}
            </button>
            <span className="text-xs text-ink-faint">
              {isOwner
                ? "Owner-only, and that is you."
                : owner === undefined
                  ? "Reading the owner…"
                  : `Owner-only. This contract's owner is ${shortenAddress(owner)}.`}
            </span>
            <TxStatus state={withdraw.state} />
          </div>
        </div>
      )}
    </Card>
  );
}
