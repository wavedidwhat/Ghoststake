import { request } from "./api";
import { activeChain } from "./wagmi";

/**
 * The client for `GET /api/v1/activity/{address}` — one merged, paginated
 * feed of everything an address has done, across the lending ledger and the
 * round history.
 *
 * Read from the API rather than from the chain, unlike `useRounds`. The chain
 * cannot answer this question: an address's history is thousands of past logs
 * spread over months, and `eth_getLogs` over that range is either rate-limited
 * away or takes minutes. The indexer already holds it in an append-only table
 * with an index built for exactly this read.
 *
 * The trade is that this view is `INDEXER_CONFIRMATIONS` behind the head. That
 * lag is a fact the page has to state, not hide — see `indexedBlock`.
 */

/**
 * What happened, in the API's vocabulary.
 *
 * A union rather than `string` so a `switch` over it is checked: an unhandled
 * type is a build error here instead of a blank cell in front of a user. The
 * server can still send something not in this list — it falls back to a raw
 * event name for anything it does not recognise — which is why every consumer
 * below has a default branch as well.
 */
export type ActivityType =
  | "deposit"
  | "vault_withdraw"
  | "supply"
  | "pool_withdraw"
  | "borrow"
  | "repay"
  | "yield"
  | "lien_settled"
  | "liquidation"
  | "share_transfer_in"
  | "share_transfer_out"
  | "position"
  | "claim";

export interface ActivityEvent {
  id: string;
  type: ActivityType | (string & {});
  eventName: string;
  contract: string;
  /** Decimal string. Nominal, as emitted, and never index-scaled. */
  amount: string;
  asset: "asset" | "shares";
  counterparty?: string;
  market?: string;
  roundId?: number;
  side?: "up" | "down";
  data?: Record<string, string>;
  blockNumber: number;
  blockTime: string;
  txHash: string;
  logIndex: number;
}

export interface ActivityPage {
  address: string;
  chainId: number;
  /** How far the indexer has read. Everything above this is not here yet. */
  indexedBlock: number;
  asOf: string;
  events: ActivityEvent[];
  /** Pass back as `?cursor=`. Null on the last page. */
  nextCursor: string | null;
}

export function fetchActivity(
  address: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<ActivityPage> {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);

  const query = params.toString();
  return request<ActivityPage>(
    `/api/v1/activity/${address}${query ? `?${query}` : ""}`,
  );
}

/**
 * A human label per type.
 *
 * Here rather than inline in the page so it is testable, and so the two
 * `Withdrawn` events cannot end up sharing a label by accident: the vault's
 * and the pool's are entirely different actions, and the API separates them
 * precisely so this does not have to guess.
 */
const LABELS: Record<ActivityType, string> = {
  deposit: "Staked",
  vault_withdraw: "Unstaked",
  supply: "Supplied to pool",
  pool_withdraw: "Withdrew from pool",
  borrow: "Borrowed",
  repay: "Repaid",
  yield: "Yield settled",
  lien_settled: "Lien settled on exit",
  liquidation: "Liquidated",
  share_transfer_in: "Shares received",
  share_transfer_out: "Shares sent",
  position: "Took a position",
  claim: "Claimed",
};

export function activityLabel(event: ActivityEvent): string {
  const label = LABELS[event.type as ActivityType];
  if (label) return label;
  // Anything the server sent that this build does not know about shows as
  // itself. A row reading "RoundVoided" is odd but honest; one reading
  // "Unknown" looks like the data is broken.
  return event.eventName || event.type;
}

/**
 * Which way the money went, from this address's point of view.
 *
 * "out" is value leaving the wallet, "in" is value arriving, "neutral" is a
 * bookkeeping event that moved nothing on its own.
 *
 * Deliberately not inferred from the amount's sign: the API sends absolute
 * amounts, precisely so nothing has to interpret a minus sign. Direction is a
 * property of what the action *was*.
 */
export type Direction = "in" | "out" | "neutral";

const DIRECTIONS: Record<ActivityType, Direction> = {
  deposit: "out",
  vault_withdraw: "in",
  supply: "out",
  pool_withdraw: "in",
  borrow: "in",
  repay: "out",
  position: "out",
  claim: "in",
  share_transfer_in: "in",
  share_transfer_out: "out",
  // A liquidation moves the user's collateral to a liquidator, so value does
  // leave — but the debt it clears leaves with it, and calling it "out"
  // alongside a repay would suggest the user chose it.
  liquidation: "neutral",
  // Yield settled and a lien settled at exit are both checkpoints: they move
  // a figure from one book to another inside the protocol without anything
  // crossing the wallet boundary.
  yield: "neutral",
  lien_settled: "neutral",
};

export function activityDirection(event: ActivityEvent): Direction {
  return DIRECTIONS[event.type as ActivityType] ?? "neutral";
}

/**
 * A link to the transaction on the chain's own explorer.
 *
 * Undefined where the chain has no explorer — a local anvil — rather than a
 * dead link. Every row on this page is a claim about what happened, and the
 * explorer is the only way a user can check it against something that is not
 * us. A broken link there is worse than none.
 */
export function explorerTxUrl(txHash: string): string | undefined {
  const base = activeChain.blockExplorers?.default.url;
  if (!base) return undefined;
  return `${base.replace(/\/$/, "")}/tx/${txHash}`;
}

/** Short form of an address or hash, for a dense table. */
export function shortHash(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 2) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/**
 * A position opened with borrowed funds, told from a cash one.
 *
 * The only way to know after the fact: the router paid, so the funder on the
 * event is the router's address and not the user's. There is nowhere else
 * this survives — the contract does not record it.
 */
export function wasLeveraged(event: ActivityEvent, address: string): boolean {
  const funder = event.data?.funder;
  if (!funder || event.type !== "position") return false;
  return funder.toLowerCase() !== address.toLowerCase();
}
