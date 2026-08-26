import { describe, expect, it } from "vitest";
import { createPublicClient, http, parseAbi } from "viem";
import { maxWithdraw, shareOfPool, utilizationAfter, withdrawProblem } from "../lend";

/**
 * The lender helpers, against a real pool.
 *
 * The fixture tests prove the arithmetic. They cannot prove the thing that
 * actually bites: that `utilization()` is computed from the pool's *token
 * balance* rather than from `totalSupplied`, and that a withdrawal has two
 * separate ceilings with two separate reverts. Both are restatements of
 * contract internals, and a restatement that drifts is a Max button that
 * proposes a transaction the chain refuses.
 *
 * Skipped unless pointed at a chain, the way the operator live test is:
 *
 *   LIVE_RPC_URL=http://127.0.0.1:8545 POOL_ADDRESS=0x… pnpm test
 */
const RPC = process.env.LIVE_RPC_URL;
const POOL = process.env.POOL_ADDRESS as `0x${string}` | undefined;

const poolAbi = parseAbi([
  "function totalSupplied() view returns (uint256)",
  "function totalBorrowed() view returns (uint256)",
  "function availableLiquidity() view returns (uint256)",
  "function utilization() view returns (uint256)",
  "function balanceOfSupply(address) view returns (uint256)",
]);

describe.skipIf(!RPC || !POOL)("lend helpers against a live pool", () => {
  let cached: ReturnType<typeof createPublicClient> | undefined;
  const client = () => (cached ??= createPublicClient({ transport: http(RPC) }));

  const read = async <T>(functionName: string, args: readonly unknown[] = []) =>
    (await client().readContract({
      address: POOL!,
      abi: poolAbi,
      functionName,
      args,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as T;

  it("computes utilization the way the contract does", async () => {
    const [borrowed, available, onChain] = await Promise.all([
      read<bigint>("totalBorrowed"),
      read<bigint>("availableLiquidity"),
      read<bigint>("utilization"),
    ]);

    // Zero delta must reproduce the contract's own number exactly. This is
    // the assertion that catches the tempting wrong denominator: measuring
    // against `totalSupplied` agrees with the contract only while no interest
    // has accrued, so it passes on a fresh deploy and drifts thereafter.
    expect(utilizationAfter(borrowed, available, 0n)).toBe(onChain);
  });

  it("never proposes a withdrawal the pool would refuse", async () => {
    const [supplied, available] = await Promise.all([
      read<bigint>("totalSupplied"),
      read<bigint>("availableLiquidity"),
    ]);

    // Whoever holds the whole pool is the strictest case available without
    // sending transactions: their balance is `totalSupplied`, so if the pool
    // is lent out at all, their balance exceeds the cash.
    const max = maxWithdraw(supplied, available);
    expect(max).toBeLessThanOrEqual(available);
    expect(max).toBeLessThanOrEqual(supplied);
    expect(withdrawProblem(max, supplied, available)).toBeNull();

    // And one unit past it is refused, unless the pool happens to hold cash
    // in excess of every claim on it.
    if (max < supplied) {
      expect(withdrawProblem(max + 1n, supplied, available)).toBe("over-liquidity");
    }
  });

  it("reports a share of the pool that cannot exceed the whole", async () => {
    const supplied = await read<bigint>("totalSupplied");
    expect(shareOfPool(supplied, supplied)).toBe(10n ** 18n);
  });
});
