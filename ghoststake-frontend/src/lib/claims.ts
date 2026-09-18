/**
 * What a wallet can collect, across every market (GHO-69).
 *
 * The plumbing lives here rather than in the component so the awkward parts —
 * what counts as claimable, what a partly-failed run means, how many
 * signatures to promise — are testable without a wallet.
 */

/**
 * Just `claim`, as its own ABI.
 *
 * `parimutuelRoundAbi` is the generated article and stays the source of truth
 * for everything else. Handing the whole thing to viem's `simulateContract`
 * makes TypeScript enumerate every function's argument tuple to resolve the
 * overload, which overflows: TS2590, "union type that is too complex to
 * represent", after a `tsc` run that chews a core for minutes first.
 *
 * `claimAbiMatchesGenerated` in the tests asserts this is byte-for-byte the
 * generated entry, so the narrowing cannot drift away from the contract.
 */
export const claimAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "roundId", type: "uint256", internalType: "uint256" },
      { name: "user", type: "address", internalType: "address" },
    ],
    // `claim` returns the payout. Copying it by hand, I had this as `outputs:
    // []` and the argument as `account` — both wrong, and the pinning test
    // below caught them on its first run, which is the entire argument for
    // having it.
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
  },
] as const;

export type Claimable = {
  /** The market contract holding the payout. */
  market: `0x${string}`;
  /** Round ids restart at 1 in every market, so this is never a key alone. */
  roundId: bigint;
  /** What `claimableOf` says, at the block it was read. */
  amount: bigint;
};

/** One claim's fate in a run. */
export type ClaimOutcome =
  | { state: "pending"; claim: Claimable }
  | { state: "claimed"; claim: Claimable; hash: `0x${string}` }
  /** Simulated and would revert — not sent, and not the user's fault. */
  | { state: "skipped"; claim: Claimable; reason: string }
  | { state: "cancelled"; claim: Claimable }
  | { state: "failed"; claim: Claimable; reason: string };

export function claimKey(claim: Claimable): string {
  return `${claim.market.toLowerCase()}:${claim.roundId}`;
}

/**
 * Sorted by size, largest first.
 *
 * A run can be abandoned halfway — every claim is its own signature, and
 * somebody will stop after two. Collecting the biggest first means whatever
 * they did sign was the part worth signing.
 */
export function orderClaims(claims: Claimable[]): Claimable[] {
  return [...claims].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
}

export function totalClaimable(claims: Claimable[]): bigint {
  return claims.reduce((sum, claim) => sum + claim.amount, 0n);
}

/**
 * What the run actually collected.
 *
 * Only confirmed claims count. A skipped or failed one is money still in the
 * contract, and reporting it as collected is exactly the lie this whole issue
 * exists to stop.
 */
export function collected(outcomes: ClaimOutcome[]): bigint {
  return outcomes.reduce(
    (sum, outcome) => (outcome.state === "claimed" ? sum + outcome.claim.amount : sum),
    0n,
  );
}

export type RunSummary = {
  claimed: number;
  skipped: number;
  failed: number;
  cancelled: number;
  remaining: number;
};

export function summarise(outcomes: ClaimOutcome[]): RunSummary {
  const count = (state: ClaimOutcome["state"]) =>
    outcomes.filter((outcome) => outcome.state === state).length;

  return {
    claimed: count("claimed"),
    skipped: count("skipped"),
    failed: count("failed"),
    cancelled: count("cancelled"),
    remaining: count("pending"),
  };
}

/**
 * The sentence shown before anything is signed.
 *
 * It says the number of signatures out loud. There is no batch-claim function
 * on `ParimutuelRound` — a payout is pull-based, per round, per market — so
 * "Claim all" is one button over N transactions, and a user who expects one
 * wallet prompt and gets five has been misled by the button, not by the
 * chain. If a batch entry point is ever added, this is the first thing that
 * changes.
 */
export function signaturesNeeded(count: number): string {
  if (count === 1) return "One signature.";
  return `${count} signatures, one per round — there is no batch claim on chain.`;
}

/**
 * Why a simulated claim refused, in a few words.
 *
 * Chain errors arrive as several paragraphs of RPC detail with the useful
 * part in the middle. A custom error name is the useful part: `AlreadyClaimed`
 * says the money is already collected, which is a completely different thing
 * from a failure, and the user should be told which they hit.
 */
export function revertReason(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);

  const custom = /(?:reverted with the following reason:|Error:)\s*([A-Za-z0-9_]+)\(/.exec(message);
  if (custom?.[1]) return custom[1];

  const named = /([A-Z][A-Za-z0-9]*Error|[A-Z][A-Za-z0-9]*\(\))/.exec(message);
  if (named?.[1]) return named[1].replace(/\(\)$/, "");

  const line = message.split("\n")[0]?.trim();
  return line && line.length > 0 ? line : "the chain refused it";
}
