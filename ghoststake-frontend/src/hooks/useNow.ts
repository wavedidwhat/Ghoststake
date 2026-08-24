"use client";

import { useEffect, useState } from "react";

/**
 * The current time in seconds, ticking once a second.
 *
 * Countdowns are computed from this rather than from a per-component
 * `setInterval`, so every clock on the page moves on the same tick and they
 * cannot visibly disagree.
 *
 * Seeded on the client only. Rendering a live clock during SSR would hydrate
 * into a mismatch, and the value would be the server's second rather than the
 * viewer's.
 */
export function useNow(): bigint | undefined {
  const [now, setNow] = useState<bigint>();

  useEffect(() => {
    const tick = () => setNow(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return now;
}
