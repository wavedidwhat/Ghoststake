"use client";

import { useEffect, useState } from "react";

/**
 * How long a wallet gets to answer before a surface offers a way out.
 *
 * Eight seconds is long enough that nobody waiting on a wallet that is about
 * to answer sees it, and short enough to beat the reflex to reload the page.
 */
export const STALL_AFTER_MS = 8_000;

/**
 * Whether `active` has been continuously true for `afterMs`.
 *
 * Written for GHO-77, where "connecting" was a state with no exit, and lifted
 * here by GHO-83 because it was not the only one. Signing a SIWE message and
 * sending a transaction have the same shape and had the same bug: an await on
 * a wallet that accepts a request and never answers, with nothing above it
 * bounding the wait.
 *
 * One implementation rather than three, because the interesting part is not
 * the timer — it is the `restartKey` below, and three copies would be three
 * chances to get that wrong.
 *
 * `restartKey` changes when a fresh attempt begins, so a retry shows its own
 * wait for its own eight seconds rather than inheriting the previous attempt's
 * verdict and looking like the click did nothing.
 *
 * The verdict is keyed on the attempt rather than being a bare boolean. A
 * boolean would have to be reset from the effect body on every restart, which
 * is the cascading-render pattern `react-hooks/set-state-in-effect` exists to
 * stop; comparing keys resets by itself, since a new attempt cannot match an
 * old verdict.
 */
export function useStalled(active: boolean, restartKey: number, afterMs = STALL_AFTER_MS): boolean {
  const [stalledKey, setStalledKey] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setStalledKey(restartKey), afterMs);
    return () => clearTimeout(timer);
  }, [active, afterMs, restartKey]);

  return active && stalledKey === restartKey;
}
