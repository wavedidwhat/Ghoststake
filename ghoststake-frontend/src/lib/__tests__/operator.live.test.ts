import { describe, expect, it } from "vitest";
import { createPublicClient, http, parseAbi } from "viem";
import { findCloseRound } from "../operator";

/**
 * The feed search, against a real chain.
 *
 * Every other test here feeds `findCloseRound` a fixture, which proves the
 * algorithm and nothing about the two things that actually bite: an
 * aggregator *reverts* on an id it has no data for rather than returning
 * zero, and `latestRoundData` returns a tuple whose fields are easy to index
 * wrongly. Both are invisible to a fixture and fatal in the console.
 *
 * Skipped unless pointed at a chain, the way the backend's live tests are:
 *
 *   LIVE_RPC_URL=http://127.0.0.1:8545 \
 *   DEMO_FEED_ADDRESS=0x… DEMO_MARKET_ADDRESS=0x… pnpm test
 */
const RPC = process.env.LIVE_RPC_URL;
const FEED = process.env.DEMO_FEED_ADDRESS as `0x${string}` | undefined;
const MARKET = process.env.DEMO_MARKET_ADDRESS as `0x${string}` | undefined;

const feedAbi = parseAbi([
  "function getRoundData(uint80) view returns (uint80,int256,uint256,uint256,uint80)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

const marketAbi = parseAbi([
  "function roundCount() view returns (uint256)",
  "function rounds(uint256) view returns ((uint64,uint64,uint64,uint8,uint8,uint256,uint256,uint80,uint256,uint256,uint256))",
]);

describe.skipIf(!RPC || !FEED || !MARKET)("findCloseRound against a live feed", () => {
  // Built on first use, not in the describe body. `skipIf` still *runs* the
  // body to collect the tests, and `http(undefined)` throws there — which
  // failed the whole suite for anyone without the env set, this file's own
  // reason for existing inverted.
  let cached: ReturnType<typeof createPublicClient> | undefined;
  const publicClient = () => (cached ??= createPublicClient({ transport: http(RPC) }));

  const readRound = async (id: bigint) => {
    try {
      const data = await publicClient().readContract({
        address: FEED!,
        abi: feedAbi,
        functionName: "getRoundData",
        args: [id],
      });
      return { updatedAt: data[3] };
    } catch {
      // The normal path for a gap, not an error: an aggregator with no data
      // at an id reverts.
      return null;
    }
  };

  it("names a feed round the adapter would accept for a settled round", async () => {
    const count = await publicClient().readContract({
      address: MARKET!,
      abi: marketAbi,
      functionName: "roundCount",
    });
    expect(count).toBeGreaterThan(0n);

    const round = await publicClient().readContract({
      address: MARKET!,
      abi: marketAbi,
      functionName: "rounds",
      args: [count],
    });
    const closeTime = round[2];

    const latest = await publicClient().readContract({
      address: FEED!,
      abi: feedAbi,
      functionName: "latestRoundData",
    });

    const found = await findCloseRound(readRound, latest[0], closeTime);
    expect(found).not.toBeNull();

    // The two halves of the pinning rule, checked against what the feed
    // actually holds: the named round is at or before the close, and the one
    // after it lands strictly later.
    const at = await readRound(found!);
    const next = await readRound(found! + 1n);
    expect(at!.updatedAt).toBeLessThanOrEqual(closeTime);
    expect(next).not.toBeNull();
    expect(next!.updatedAt).toBeGreaterThan(closeTime);
  });

  it("returns nothing for a close in the future", async () => {
    const latest = await publicClient().readContract({
      address: FEED!,
      abi: feedAbi,
      functionName: "latestRoundData",
    });
    expect(await findCloseRound(readRound, latest[0], latest[3] + 10_000n)).toBeNull();
  });
});
