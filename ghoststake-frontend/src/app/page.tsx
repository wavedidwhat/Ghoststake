"use client";

import { MarketsScreen } from "@/components/MarketsScreen";

/**
 * Home is the market feed (GHO-62).
 *
 * It used to be a lending dashboard: vault balance, health factor, terms —
 * all of it meaningless to someone who has never staked, and all of it behind
 * a connect wallet prompt. A first-time visitor arrived at a wall and the
 * product's actual surface, the live rounds, was one more tap away.
 *
 * The dashboard did not disappear; it is `/portfolio`, where it belongs, next
 * to what you have riding on those rounds.
 */
export default function HomePage() {
  return <MarketsScreen />;
}
