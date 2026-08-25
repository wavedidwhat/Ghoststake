import { describe, expect, it } from "vitest";
import type { MarketRound } from "@/hooks/useRounds";
import { byActivity, formatHorizon, summarise } from "../marketList";
import type { Market } from "../markets";
import { Phase, Status, type Round } from "../rounds";

function market(key: string, over: Partial<Market> = {}): Market {
  return {
    key,
    address: `0x${key.repeat(40).slice(0, 40)}` as `0x${string}`,
    router: `0x${"9".repeat(40)}` as `0x${string}`,
    enabled: true,
    kindHint: "unknown",
    ...over,
  };
}

function round(m: Market, over: Partial<Round> = {}, phase: number = Phase.Open): MarketRound {
  return {
    market: m,
    id: 1n,
    round: {
      openTime: 0n,
      lockTime: 100n,
      closeTime: 200n,
      status: Status.Open,
      winner: 0,
      lockPrice: 0n,
      closePrice: 0n,
      lockOracleRoundId: 0n,
      upPool: 0n,
      downPool: 0n,
      rakeTaken: 0n,
      ...over,
    },
    phase,
    up: undefined,
    down: undefined,
    claimable: undefined,
    isClaimed: undefined,
  };
}

describe("summarising a market for the list", () => {
  it("picks the newest unsettled round", () => {
    const m = market("a");
    // Newest first, as `useRounds` returns them.
    const rounds = [
      { ...round(m, { upPool: 5n }, Phase.Open), id: 3n },
      { ...round(m, { upPool: 9n }, Phase.Resolved), id: 2n },
    ];
    const summary = summarise(m, rounds, undefined);
    expect(summary.live?.id).toBe(3n);
    expect(summary.volume).toBe(5n);
  });

  it("ignores rounds belonging to other markets", () => {
    // Round ids restart at 1 in every market, so a summary that filtered on
    // id alone would show another market's pools.
    const mine = market("a");
    const theirs = market("b");
    const summary = summarise(mine, [round(theirs, { upPool: 100n })], undefined);
    expect(summary.live).toBeUndefined();
    expect(summary.volume).toBe(0n);
  });

  it("treats a settled-only market as having nothing live", () => {
    const m = market("a");
    expect(summarise(m, [round(m, { upPool: 7n }, Phase.Void)], undefined).live).toBeUndefined();
  });
});

describe("ordering the list by activity", () => {
  const withVolume = (key: string, volume: bigint | null) => {
    const m = market(key);
    return volume === null
      ? summarise(m, [], undefined)
      : summarise(m, [round(m, { upPool: volume })], undefined);
  };

  it("puts live markets above quiet ones, and bigger pools first", () => {
    const order = [withVolume("a", null), withVolume("b", 10n), withVolume("c", 500n)]
      .sort(byActivity)
      .map((s) => s.market.key);
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("breaks ties stably rather than shuffling as pools move", () => {
    // Sorting on volume alone leaves equal rows in whatever order the source
    // produced, and this list re-sorts every six seconds.
    const a = withVolume("b", 10n);
    const b = withVolume("a", 10n);
    expect([a, b].sort(byActivity).map((s) => s.market.key)).toEqual(["a", "b"]);
    expect([b, a].sort(byActivity).map((s) => s.market.key)).toEqual(["a", "b"]);
  });
});

describe("horizons", () => {
  it("reads as an operator would say it", () => {
    expect(formatHorizon(300n)).toBe("5m");
    expect(formatHorizon(3600n)).toBe("1h");
    expect(formatHorizon(86_400n)).toBe("24h");
    expect(formatHorizon(90n)).toBe("90s");
  });
});
