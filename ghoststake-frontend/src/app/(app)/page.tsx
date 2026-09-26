import { MarketsScreen } from "@/components/MarketsScreen";
import { parseCategory } from "@/lib/marketCategory";
import { singleParam } from "@/lib/searchParams";

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
 *
 * `?c=` picks a category tab (GHO-101). Read here on the server, like
 * `/activity`'s `?address=`, rather than with `useSearchParams` in the
 * screen, so the tabs are plain links and the first paint already shows the
 * right one.
 */
export default async function HomePage({ searchParams }: PageProps<"/">) {
  return <MarketsScreen category={parseCategory(singleParam((await searchParams).c))} />;
}
