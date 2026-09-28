import { describe, expect, it } from "vitest";
import { translate } from "@/test/intl";
import { maxUint256 } from "viem";
import { alertsFor, unseen } from "../alerts";

const WAD = 10n ** 18n;
const hf = (x: number) => (BigInt(Math.round(x * 1000)) * WAD) / 1000n;
const M = "0x00000000000000000000000000000000000e2e03" as const;
const base = { claims: [], healthFactor: maxUint256, decimals: 6, symbol: "mUSDC" };

describe("alertsFor (GHO-104)", () => {
  it("is silent when there is nothing to do", () => {
    expect(alertsFor(base)).toEqual([]);
    // No debt is the max sentinel, not a safety problem.
    expect(alertsFor({ ...base, healthFactor: maxUint256 })).toEqual([]);
    expect(alertsFor({ ...base, healthFactor: hf(2.1) })).toEqual([]);
  });

  it("warns below 1.5 and calls it danger below 1.2, the bands the safety card uses", () => {
    const caution = alertsFor({ ...base, healthFactor: hf(1.38) });
    expect(caution).toHaveLength(1);
    expect(caution[0]).toMatchObject({ id: "health:caution", tone: "warning" });
    expect(translate(caution[0].title)).toBe("Safety 1.38");

    const danger = alertsFor({ ...base, healthFactor: hf(1.12) });
    expect(danger[0]).toMatchObject({ id: "health:danger", tone: "negative", href: "/borrow" });
  });

  it("totals winnings across rounds, on the token's scale", () => {
    const [a] = alertsFor({
      ...base,
      claims: [
        { market: M, roundId: 3n, amount: 18_400_000n },
        { market: M, roundId: 4n, amount: 1_600_000n },
      ],
    });
    expect(translate(a.title)).toBe("20.00 mUSDC to claim");
    expect(translate(a.body)).toContain("2 rounds");
    expect(a.href).toBe("/portfolio");
  });

  it("says nothing about an amount before the token's scale is known", () => {
    // GHO-86: a figure formatted against a guessed scale is a plausible wrong
    // number. No scale, no winnings alert yet.
    expect(alertsFor({ ...base, decimals: undefined, claims: [{ market: M, roundId: 3n, amount: 1n }] })).toEqual([]);
  });

  it("leads with safety, because that one costs money if it waits", () => {
    const alerts = alertsFor({ ...base, healthFactor: hf(1.1), claims: [{ market: M, roundId: 3n, amount: 1_000_000n }] });
    expect(alerts.map((a) => a.id.split(":")[0])).toEqual(["health", "claim"]);
  });
});

describe("what counts as news", () => {
  const one = [{ market: M, roundId: 3n, amount: 1_000_000n }];
  const two = [...one, { market: M, roundId: 4n, amount: 1_000_000n }];

  it("a newly settled round is news even when others are already waiting", () => {
    const before = alertsFor({ ...base, claims: one });
    const after = alertsFor({ ...base, claims: two });
    expect(unseen(after, new Set(before.map((a) => a.id)))).toHaveLength(1);
  });

  it("the same winnings, read again, are not", () => {
    const before = alertsFor({ ...base, claims: one });
    expect(unseen(alertsFor({ ...base, claims: one }), new Set(before.map((a) => a.id)))).toEqual([]);
  });

  it("drifting inside a band is not news; falling into the next one is", () => {
    const seen = new Set(alertsFor({ ...base, healthFactor: hf(1.45) }).map((a) => a.id));
    expect(unseen(alertsFor({ ...base, healthFactor: hf(1.3) }), seen)).toEqual([]);
    expect(unseen(alertsFor({ ...base, healthFactor: hf(1.15) }), seen)).toHaveLength(1);
  });
});
