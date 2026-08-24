import { WAD } from "./format";

/** Mirrors `ParimutuelRound.Status`. */
export const Status = {
  None: 0,
  Open: 1,
  Locked: 2,
  Resolved: 3,
  Void: 4,
} as const;

/** Mirrors `ParimutuelRound.Phase`. */
export const Phase = {
  None: 0,
  Open: 1,
  Cutoff: 2,
  Observation: 3,
  Resolved: 4,
  Void: 5,
} as const;

export type PhaseValue = (typeof Phase)[keyof typeof Phase];

export const Side = { Up: 0, Down: 1 } as const;
export type SideValue = (typeof Side)[keyof typeof Side];

export type Round = {
  openTime: bigint;
  lockTime: bigint;
  closeTime: bigint;
  status: number;
  winner: number;
  lockPrice: bigint;
  closePrice: bigint;
  lockOracleRoundId: bigint;
  upPool: bigint;
  downPool: bigint;
  rakeTaken: bigint;
};

/**
 * Whether a new stake would actually be accepted right now.
 *
 * This is the entry cutoff, and it is the one piece of round state a UI can
 * get wrong in a way that costs a user money. `takePosition` refuses inside
 * `entryCutoff` seconds of the lock, so a button that stays live until
 * `lockTime` is lying for the last fifteen seconds — the user pays gas for a
 * transaction that was never going to land.
 *
 * The buffer exists to stop someone front-running the pending `lockRound`
 * transaction. Surfacing it honestly is the price of having it.
 */
export function entryOpen(round: Round, entryCutoff: bigint, nowSeconds: bigint): boolean {
  if (round.status !== Status.Open) return false;
  if (nowSeconds < round.openTime) return false;
  return nowSeconds + entryCutoff < round.lockTime;
}

/**
 * The instant entry actually closes, which is earlier than the lock.
 *
 * A countdown should run to this, not to `lockTime`.
 */
export function entryClosesAt(round: Round, entryCutoff: bigint): bigint {
  return round.lockTime - entryCutoff;
}

/**
 * What a side pays per unit staked, if it wins, at the pool's current shape.
 *
 * Derived, never stored: `(total - rake) / side`. It moves as people enter,
 * so it is a live quote and not a promise — which is the honest way to label
 * it in the UI too.
 *
 * Returns null while a side is empty, because the multiple is unbounded there
 * and rendering "∞" invites someone to read it as a payout.
 */
export function multipleFor(round: Round, side: SideValue, rake: bigint): bigint | null {
  const sidePool = side === Side.Up ? round.upPool : round.downPool;
  if (sidePool === 0n) return null;

  const total = round.upPool + round.downPool;
  const distributable = total - (total * rake) / WAD;
  return (distributable * WAD) / sidePool;
}

/**
 * Whether the round can still pay out at all.
 *
 * A side under `minSidePool` at lock voids the round and refunds everyone, so
 * a one-sided pool is worth warning about *before* someone joins the side
 * that is already ahead.
 */
export function willVoidOnLock(round: Round, minSidePool: bigint): boolean {
  return round.upPool < minSidePool || round.downPool < minSidePool;
}

export function phaseLabel(phase: PhaseValue): string {
  switch (phase) {
    case Phase.Open:
      return "Open";
    case Phase.Cutoff:
      return "Entry closed";
    case Phase.Observation:
      return "Running";
    case Phase.Resolved:
      return "Settled";
    case Phase.Void:
      return "Voided";
    default:
      return "Unknown";
  }
}

/** mm:ss, or h:mm:ss past an hour. Clamped at zero rather than going negative. */
export function formatCountdown(seconds: bigint): string {
  const total = seconds > 0n ? Number(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
