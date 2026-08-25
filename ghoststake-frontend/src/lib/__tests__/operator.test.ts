import { describe, expect, it } from "vitest";
import {
  Action,
  actionFor,
  findCloseRound,
  isOwnerOnly,
  scheduleFrom,
  scheduleProblem,
  warningsFor,
} from "../operator";
import { Phase, Status, type Round } from "../rounds";

const TIMING = { entryCutoff: 15n, lockWindow: 60n, resolveDeadline: 3600n };
const MIN_SIDE = 10_000_000n; // 10 mUSDC at 6 decimals

function round(over: Partial<Round> = {}): Round {
  return {
    openTime: 1000n,
    lockTime: 2000n,
    closeTime: 3000n,
    status: Status.Open,
    winner: 0,
    lockPrice: 0n,
    closePrice: 0n,
    lockOracleRoundId: 0n,
    upPool: 100_000_000n,
    downPool: 100_000_000n,
    rakeTaken: 0n,
    ...over,
  };
}

describe("what a round needs next", () => {
  it("wants nothing before the lock time", () => {
    expect(actionFor(round(), Phase.Open, TIMING, 1999n)).toBe(Action.None);
  });

  it("wants a lock from the lock time until the window closes", () => {
    expect(actionFor(round(), Phase.Cutoff, TIMING, 2000n)).toBe(Action.Lock);
    expect(actionFor(round(), Phase.Cutoff, TIMING, 2060n)).toBe(Action.Lock);
    // One second past the window: locking can no longer succeed, so offering
    // it would be offering a transaction that reverts.
    expect(actionFor(round(), Phase.Cutoff, TIMING, 2061n)).toBe(Action.VoidUnlocked);
  });

  it("still wants a lock on a thin round", () => {
    // `lockRound` voids a thin round itself. The button is right; the warning
    // is what has to say so.
    const thin = round({ downPool: 0n });
    expect(actionFor(thin, Phase.Cutoff, TIMING, 2000n)).toBe(Action.Lock);
  });

  it("wants a resolve from the close until the deadline, then a void", () => {
    const locked = round({ status: Status.Locked });
    expect(actionFor(locked, Phase.Observation, TIMING, 2999n)).toBe(Action.None);
    expect(actionFor(locked, Phase.Observation, TIMING, 3000n)).toBe(Action.Resolve);
    expect(actionFor(locked, Phase.Observation, TIMING, 6600n)).toBe(Action.Resolve);
    expect(actionFor(locked, Phase.Observation, TIMING, 6601n)).toBe(Action.VoidUnsettled);
  });

  it("wants nothing from a round that has already settled", () => {
    expect(actionFor(round({ status: Status.Resolved }), Phase.Resolved, TIMING, 9999n)).toBe(
      Action.None,
    );
    expect(actionFor(round({ status: Status.Void }), Phase.Void, TIMING, 9999n)).toBe(Action.None);
  });

  it("knows which actions the contract gates on the owner", () => {
    // The two voids differ, and the console must not claim otherwise: past
    // the lock window nothing can lock anyway, so unwinding names what is
    // already true and stays permissionless.
    expect(isOwnerOnly(Action.VoidUnsettled)).toBe(true);
    expect(isOwnerOnly(Action.VoidUnlocked)).toBe(false);
    expect(isOwnerOnly(Action.Lock)).toBe(false);
    expect(isOwnerOnly(Action.Resolve)).toBe(false);
  });
});

describe("warnings", () => {
  const codes = (...args: Parameters<typeof warningsFor>) =>
    warningsFor(...args).map((w) => w.code);

  it("says a thin side will void the round at lock", () => {
    expect(codes(round({ upPool: 1n }), Phase.Open, TIMING, MIN_SIDE, 1500n)).toContain("thin-side");
    expect(codes(round(), Phase.Open, TIMING, MIN_SIDE, 1500n)).not.toContain("thin-side");
  });

  it("warns while the lock window is closing, not after", () => {
    // Window is 2000..2060; the last third is 2040 onward.
    expect(codes(round(), Phase.Cutoff, TIMING, MIN_SIDE, 2030n)).not.toContain(
      "lock-window-closing",
    );
    expect(codes(round(), Phase.Cutoff, TIMING, MIN_SIDE, 2045n)).toContain("lock-window-closing");
    expect(codes(round(), Phase.Cutoff, TIMING, MIN_SIDE, 2100n)).toContain("lock-window-missed");
  });

  it("warns as the resolve deadline approaches", () => {
    const locked = round({ status: Status.Locked });
    expect(codes(locked, Phase.Observation, TIMING, MIN_SIDE, 4000n)).toEqual([]);
    expect(codes(locked, Phase.Observation, TIMING, MIN_SIDE, 6000n)).toContain(
      "resolve-deadline-closing",
    );
  });

  it("says nothing about a round that has settled", () => {
    expect(codes(round({ status: Status.Void, upPool: 0n }), Phase.Void, TIMING, MIN_SIDE, 9999n)).toEqual(
      [],
    );
  });
});

describe("scheduling a round", () => {
  it("applies the lead to every deadline", () => {
    expect(scheduleFrom(1000n, 60n, 300n, 600n)).toEqual({
      openTime: 1060n,
      lockTime: 1360n,
      closeTime: 1960n,
    });
  });

  it("rejects what the contract would reject, and says which rule", () => {
    const ok = scheduleFrom(1000n, 60n, 300n, 600n);
    expect(scheduleProblem(ok, 15n, 1000n)).toBeNull();

    // openTime in the past
    expect(scheduleProblem({ openTime: 900n, lockTime: 1200n, closeTime: 1500n }, 15n, 1000n)).toMatch(
      /past/,
    );
    // An entry window shorter than the cutoff opens a round nobody can enter.
    expect(scheduleProblem(scheduleFrom(1000n, 60n, 15n, 600n), 15n, 1000n)).toMatch(/entry cutoff/);
    // Zero observation
    expect(scheduleProblem(scheduleFrom(1000n, 60n, 300n, 0n), 15n, 1000n)).toMatch(/observation/);
  });
});

describe("finding the feed round that closes a round", () => {
  /** A feed publishing every `every` seconds from `start`, ids 1..n. */
  function feed(start: bigint, every: bigint, count: bigint, firstId = 1n) {
    let reads = 0;
    const read = async (id: bigint) => {
      reads += 1;
      if (id < firstId || id >= firstId + count) return null;
      return { updatedAt: start + (id - firstId) * every };
    };
    return { read, latest: firstId + count - 1n, reads: () => reads };
  }

  it("finds the last round at or before the close", async () => {
    // ids 1..1000, published at 1000, 1020, 1040 … close at 5000 sits on id 201
    const f = feed(1000n, 20n, 1000n);
    expect(await findCloseRound(f.read, f.latest, 5000n)).toBe(201n);
  });

  it("takes the round exactly on the close, not the one after", async () => {
    // The adapter's rule is "at or before", so an exact hit is the answer.
    const f = feed(1000n, 20n, 1000n);
    expect(await findCloseRound(f.read, f.latest, 1040n)).toBe(3n);
  });

  it("does not walk the whole feed", async () => {
    const f = feed(1000n, 20n, 100_000n);
    await findCloseRound(f.read, f.latest, 1_000_000n);
    // Logarithmic, not linear: the point of the search.
    expect(f.reads()).toBeLessThan(60);
  });

  it("returns nothing when the feed has not published since the close", async () => {
    // The honest answer is "wait", not a candidate the adapter will refuse:
    // pinning needs a round published strictly after the close.
    const f = feed(1000n, 20n, 10n); // last publication at 1180
    expect(await findCloseRound(f.read, f.latest, 5000n)).toBeNull();
  });

  it("returns nothing when the close predates the feed's history", async () => {
    // A Chainlink proxy returns no data below the current phase's first
    // round, so ids in the middle of the range can be empty too.
    const f = feed(5000n, 20n, 100n, 500n);
    expect(await findCloseRound(f.read, f.latest, 4000n)).toBeNull();
  });

  it("searches a feed whose history starts at an arbitrary id", async () => {
    // Phase-shifted ids: nothing below 90_000 exists.
    const f = feed(1000n, 20n, 1000n, 90_000n);
    expect(await findCloseRound(f.read, f.latest, 5000n)).toBe(90_200n);
  });
});
