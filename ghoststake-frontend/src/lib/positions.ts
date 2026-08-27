import { request } from "./api";

/**
 * The client for `GET /api/v1/positions/{address}` — every round this address
 * has taken a side in, open and settled, with what each one is worth.
 *
 * Read from the API rather than the chain, and it is worth being precise about
 * why, because `useRounds` deliberately does the opposite.
 *
 * `useRounds` answers "what can I bet on right now". Its numbers decide a
 * transaction the user is about to sign — the pools they are entering, whether
 * entry is still open — and being five blocks stale there is being wrong in a
 * way that costs gas. It reads the chain, and it should.
 *
 * This answers "what happened". A settled round cannot change, so the
 * confirmation lag costs nothing; and the question spans months of rounds
 * across markets that may no longer be listed, which is the read the chain is
 * worst at. `useRounds` fetches a twelve-round window per market with a
 * multicall per refresh: `roundCount`, two reads per round, four more per round
 * per connected wallet. This is one request, already summed and phase-resolved,
 * with no window at all.
 *
 * The two are not two sources of truth for one number. They are two questions,
 * and each is asked where it can be answered.
 */

/** Mirrors the API's round status, which mirrors the contract's. */
export type RoundStatus = "open" | "locked" | "resolved" | "void" | (string & {});

/**
 * The round a position is in.
 *
 * Every uint256 is a decimal string, not a JSON number: a wei amount exceeds
 * the 53 bits of integer precision a double has, and `JSON.parse` would
 * silently fabricate its low digits.
 */
export interface PositionRound {
  /**
   * The ParimutuelRound this round belongs to, checksummed.
   *
   * Load-bearing, not decoration: round ids restart at 1 in every market, so
   * `id` alone does not identify a round and a list keyed on it merges two
   * markets' rounds into one row.
   */
  market: string;
  id: number;
  status: RoundStatus;
  phase: string;
  entryOpen: boolean;

  openTime: string;
  lockTime: string;
  closeTime: string;

  upPool: string;
  downPool: string;
  totalPool: string;
  upOdds: string;
  downOdds: string;

  lockPrice: string | null;
  closePrice: string | null;
  /** "up" or "down" on a resolved round; absent otherwise. */
  winner?: string;
  rakeTaken: string | null;
  voidReason?: string;

  lastBlock: number;
}

export interface Position {
  round: PositionRound;

  upStake: string;
  downStake: string;
  totalStake: string;
  /** What this account could collect now. Zero for a loss and once claimed. */
  claimable: string;
  claimed: boolean;
  claimedAmount: string;
  /** Opened with borrowed funds: the router paid, not the wallet. */
  leveraged: boolean;
  openedAt: string;
}

export interface PositionsResponse {
  address: string;
  chainId: number;
  /** How far the indexer has read. Everything above this is not here yet. */
  indexedBlock: number;
  asOf: string;
  /** Rounds still running. */
  open: Position[];
  /** Rounds that resolved or voided. Settled, and never changing again. */
  history: Position[];
}

export function fetchPositions(
  address: string,
  options: { limit?: number; market?: string } = {},
): Promise<PositionsResponse> {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.market) params.set("market", options.market);

  const query = params.toString();
  return request<PositionsResponse>(`/api/v1/positions/${address}${query ? `?${query}` : ""}`);
}

/**
 * How a settled position turned out, from this account's point of view.
 *
 * "void" is its own outcome rather than a flavour of win or loss. The round
 * did not happen — a side went under the minimum, or the oracle degraded — and
 * the stake comes back whole. Calling that a win because money returned would
 * overstate it, and calling it a loss because nothing was earned would be a
 * lie about a refund.
 */
export type Outcome = "won" | "lost" | "void" | "open";

export function outcomeOf(position: Position): Outcome {
  const { status, winner } = position.round;
  if (status === "void") return "void";
  if (status !== "resolved") return "open";

  if (winner === "up" || winner === "down") {
    const staked = winner === "up" ? position.upStake : position.downStake;
    return BigInt(staked) > 0n ? "won" : "lost";
  }

  // A resolved round whose winner is neither side should not happen — the
  // status is set by the same event that names the winner. But the field is
  // `omitempty` on the wire, so an older or partial payload can arrive without
  // it, and the naive reading of that is "the account held neither winning
  // side", which renders as a loss.
  //
  // Telling someone they lost is the worst available guess, and it would also
  // disagree with the server: `finance.Claimable` treats any winner that is
  // not "up" as "down" and can still compute a payout. So fall back to the
  // money, which is the same figure the server used — a position that returned
  // something won, and one that returned nothing did not.
  const returned = position.claimed ? BigInt(position.claimedAmount) : BigInt(position.claimable);
  return returned > 0n ? "won" : "lost";
}

/**
 * What the position returned, net of what went into it.
 *
 * Negative on a loss, zero on a void, positive on a win. Deliberately built
 * from `claimedAmount` once claimed and `claimable` before: those are the same
 * figure at two points in time, and reading only one of them would show a
 * claimed win as having returned nothing.
 *
 * Returns null while the round is still running — an unsettled position has no
 * result, and rendering the unrealised number as a P&L would invite someone to
 * read a live pool split as money they have.
 */
export function netOf(position: Position): bigint | null {
  const outcome = outcomeOf(position);
  if (outcome === "open") return null;

  const returned = position.claimed ? BigInt(position.claimedAmount) : BigInt(position.claimable);
  return returned - BigInt(position.totalStake);
}

/**
 * Winnings sitting unclaimed on a settled round.
 *
 * The one thing on this page a user can act on, and the reason it exists at
 * all: a parimutuel payout is pull-based, so a win that nobody claims stays in
 * the contract indefinitely. Nothing else in the app surfaces this past the
 * twelve most recent rounds of a listed market.
 */
export function isUnclaimed(position: Position): boolean {
  return !position.claimed && BigInt(position.claimable) > 0n;
}

/**
 * The side taken, or "both" where an account entered each of them.
 *
 * Both is legal and does happen — hedging a position, or adding to the other
 * side as the odds move — so this cannot assume one.
 */
export type Taken = "up" | "down" | "both" | "none";

export function sideTaken(position: Position): Taken {
  const up = BigInt(position.upStake) > 0n;
  const down = BigInt(position.downStake) > 0n;
  if (up && down) return "both";
  if (up) return "up";
  if (down) return "down";
  return "none";
}

/** Newest first, by the block the round was last touched at. */
export function byRecency(a: Position, b: Position): number {
  return b.round.lastBlock - a.round.lastBlock;
}
