import { createPublicClient, http } from "viem";
import { parimutuelRoundAbi } from "./abis";
import { formatAmount } from "./format";
import { env } from "./env";
import { activeChain } from "./wagmi";

/**
 * Server-side reads for the metadata on a market or round page.
 *
 * Separate from the wagmi hooks because this runs during `generateMetadata`,
 * where there is no React and no connected wallet — a link being unfurled by
 * Slack or a crawler has neither. Everything here is public chain state, so
 * there is nothing to authorise.
 */

const client = createPublicClient({
  chain: activeChain,
  transport: http(env.rpcUrl),
});

const feedAbi = [
  {
    type: "function",
    name: "feed",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "description",
    inputs: [],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
] as const;

/**
 * What a market prices, e.g. "ETH / USD", read from the feed itself.
 *
 * Three hops — market → oracle → feed → description — and no shortcut. The
 * registry deliberately stores no label (`MarketRegistry` keeps only what
 * nothing else knows), and the feed's own `description()` is the authority. It
 * is also the only thing that tells a Chainlink market from an operator-driven
 * demo one, which is a distinction a shared link must not blur.
 *
 * Returns null rather than throwing. A title is not worth a 500: an unfurl
 * that says "GhostStake" is a worse page than one that says "ETH / USD", and
 * both are better than a page that does not render.
 */
export async function feedLabel(market: string): Promise<string | null> {
  try {
    const oracle = await client.readContract({
      address: market as `0x${string}`,
      abi: parimutuelRoundAbi,
      functionName: "oracle",
    });
    const feed = await client.readContract({
      address: oracle as `0x${string}`,
      abi: feedAbi,
      functionName: "feed",
    });
    const description = await client.readContract({
      address: feed as `0x${string}`,
      abi: feedAbi,
      functionName: "description",
    });
    // The demo feed shouts its nature in the description; the page has a badge
    // for that, so the title takes the pair off the end.
    return String(description).split(" - ").pop() ?? null;
  } catch {
    return null;
  }
}

/** `0x1234…abcd`, for a title with no better name available. */
export function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/**
 * A price for a metadata line.
 *
 * The oracle normalises every feed to 18 decimals, so a price is WAD here
 * whatever the underlying aggregator reports.
 *
 * This exists because the first version of this metadata shipped raw base
 * units into the unfurl — "Locked at 2000000000000000000000" — which is the
 * same precision-safe string the API deliberately sends, arriving at the other
 * end as something nobody can read. A description is one line somebody glances
 * at in a chat window.
 */
export function price(value: string | null): string {
  if (value === null) return "an unknown price";
  return formatAmount(BigInt(value), 18, 2);
}

/** A pool, in the stake asset — six decimals on every deployment. */
export function pool(value: string): string {
  return formatAmount(BigInt(value), 6, 0);
}
