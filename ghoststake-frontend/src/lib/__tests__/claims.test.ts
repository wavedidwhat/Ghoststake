import { describe, expect, it } from "vitest";
import {
  claimKey,
  collected,
  orderClaims,
  revertReason,
  signaturesNeeded,
  summarise,
  totalClaimable,
  type Claimable,
  type ClaimOutcome,
} from "../claims";

const claim = (market: string, roundId: bigint, amount: bigint): Claimable => ({
  market: market as `0x${string}`,
  roundId,
  amount,
});

const A = claim("0xaaaa000000000000000000000000000000000001", 3n, 100n);
const B = claim("0xbbbb000000000000000000000000000000000002", 1n, 500n);
const C = claim("0xaaaa000000000000000000000000000000000001", 7n, 250n);

describe("keys", () => {
  it("keys on market and round together", () => {
    // Round ids restart at 1 in every market, so round 1 names as many rounds
    // as there are markets.
    expect(claimKey(claim("0xaaaa000000000000000000000000000000000001", 1n, 1n))).not.toBe(
      claimKey(claim("0xbbbb000000000000000000000000000000000002", 1n, 1n)),
    );
  });

  it("does not care how an address was cased", () => {
    expect(claimKey(claim("0xAAAA000000000000000000000000000000000001", 1n, 1n))).toBe(
      claimKey(claim("0xaaaa000000000000000000000000000000000001", 1n, 1n)),
    );
  });
});

describe("ordering", () => {
  it("puts the biggest payout first", () => {
    // Every claim is its own signature and somebody will stop after two, so
    // whatever they did sign should be the part worth signing.
    expect(orderClaims([A, B, C]).map((c) => c.amount)).toEqual([500n, 250n, 100n]);
  });

  it("leaves the caller's array alone", () => {
    const input = [A, B];
    orderClaims(input);
    expect(input).toEqual([A, B]);
  });
});

describe("totals", () => {
  it("adds up what is claimable", () => {
    expect(totalClaimable([A, B, C])).toBe(850n);
    expect(totalClaimable([])).toBe(0n);
  });

  it("counts only what actually confirmed", () => {
    // A skipped or failed claim is money still sitting in the contract.
    // Reporting it as collected is the lie this issue exists to stop.
    const outcomes: ClaimOutcome[] = [
      { state: "claimed", claim: A, hash: "0x1" },
      { state: "skipped", claim: B, reason: "AlreadyClaimed" },
      { state: "failed", claim: C, reason: "boom" },
    ];
    expect(collected(outcomes)).toBe(100n);
  });

  it("summarises a partly finished run", () => {
    const outcomes: ClaimOutcome[] = [
      { state: "claimed", claim: A, hash: "0x1" },
      { state: "skipped", claim: B, reason: "AlreadyClaimed" },
      { state: "cancelled", claim: C },
      { state: "pending", claim: C },
    ];
    expect(summarise(outcomes)).toEqual({
      claimed: 1,
      skipped: 1,
      failed: 0,
      cancelled: 1,
      remaining: 1,
    });
  });
});

describe("what the button promises", () => {
  it("says how many signatures, out loud", () => {
    // There is no batch claim on ParimutuelRound: a payout is pull-based, per
    // round, per market. A user expecting one prompt and getting five was
    // misled by the button, not by the chain.
    expect(signaturesNeeded(1)).toBe("One signature.");
    expect(signaturesNeeded(5)).toContain("5 signatures");
    expect(signaturesNeeded(5)).toContain("no batch claim");
  });
});

describe("revertReason", () => {
  it("pulls the custom error name out of an RPC essay", () => {
    const cause = new Error(
      [
        "The contract function \"claim\" reverted with the following reason:",
        "AlreadyClaimed()",
        "",
        "Contract Call:",
        "  address: 0xabc",
      ].join("\n"),
    );
    expect(revertReason(cause)).toBe("AlreadyClaimed");
  });

  it("falls back to the first line when there is no named error", () => {
    expect(revertReason(new Error("execution reverted\nlots of detail"))).toBe(
      "execution reverted",
    );
  });

  it("survives something that is not an Error at all", () => {
    expect(revertReason("nope")).toBe("nope");
    expect(revertReason(undefined)).toBe("undefined");
  });
});

describe("the narrow claim ABI", () => {
  it("is the generated entry, byte for byte", async () => {
    // `claimAbi` exists only because handing viem the full generated ABI
    // overflows its overload resolution (TS2590). That makes it a hand-copied
    // duplicate of a generated file, which is exactly the kind of thing that
    // silently drifts when the contract changes — so it is pinned here.
    const { claimAbi } = await import("../claims");
    const { parimutuelRoundAbi } = await import("../abis");

    const generated = parimutuelRoundAbi.find(
      (entry) => entry.type === "function" && entry.name === "claim",
    );

    expect(generated).toBeDefined();
    expect(claimAbi[0]).toEqual(generated);
  });
});
