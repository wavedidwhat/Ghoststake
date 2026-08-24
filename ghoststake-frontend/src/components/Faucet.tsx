"use client";

import { useSimulateContract } from "wagmi";
import { TxStatus } from "./AmountField";
import { useTransaction } from "@/hooks/useTransaction";
import { mockUSDCAbi } from "@/lib/abis";
import { formatAmount } from "@/lib/format";
import { activeChain } from "@/lib/wagmi";

/** What one tap hands out. Enough to deposit, borrow and take a position. */
const GRANT = 10_000n;

/**
 * Test tokens, for a testnet asset that allows anyone to mint.
 *
 * Without this the only way to get the stake asset is a command line, which
 * makes the app impossible to try on its own terms. It renders only when the
 * asset actually exposes `mint` — a real ERC-20 does not, so on a real
 * deployment this simply is not there rather than being a button that fails.
 */
export function Faucet({
  assetAddress,
  decimals,
  symbol,
  address,
  onMinted,
}: {
  assetAddress: `0x${string}` | undefined;
  decimals: number;
  symbol: string;
  address: `0x${string}`;
  onMinted: () => void;
}) {
  const tx = useTransaction();

  // Probes the asset rather than assuming. A simulation, not a read: `mint`
  // changes state, so it cannot be called as a view. Simulating it against a
  // token that does not implement it fails, and that failure is how we learn
  // this is a real asset and the faucet should stay hidden.
  const mintable = useSimulateContract({
    address: assetAddress,
    abi: mockUSDCAbi,
    functionName: "mint",
    args: [address, 0n],
    chainId: activeChain.id,
    query: { enabled: Boolean(assetAddress), retry: false, staleTime: Infinity },
  });

  if (!assetAddress || mintable.isError) return null;

  const amount = GRANT * 10n ** BigInt(decimals);
  const busy = tx.state.status === "signing" || tx.state.status === "pending";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-raised/40 p-4">
      <div>
        <p className="text-sm text-ink">Need test tokens?</p>
        <p className="text-xs text-ink-muted">
          {symbol} is a stand-in asset on this testnet. Anyone can mint it, and it is worth
          nothing.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <TxStatus state={tx.state} />
        <button
          disabled={busy}
          onClick={async () => {
            const ok = await tx.send({
              address: assetAddress,
              abi: mockUSDCAbi,
              functionName: "mint",
              args: [address, amount],
            });
            if (ok) onMinted();
          }}
          className="cursor-pointer rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-border-strong hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Minting…" : `Get ${formatAmount(amount, decimals, 0)} ${symbol}`}
        </button>
      </div>
    </div>
  );
}
