import { describe, expect, it } from "vitest";
import { WAD } from "../format";
import {
  Side,
  Status,
  entryClosesAt,
  entryOpen,
  formatCountdown,
  multipleFor,
  willVoidOnLock,
  type Round,
} from "../rounds";

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
    upPool: 0n,
    downPool: 0n,
    rakeTaken: 0n,
    ...over,
  };
}

const CUTOFF = 15n;

describe("entry cutoff", () => {
  it("is open in the middle of the entry window", () => {
    expect(entryOpen(round(), CUTOFF, 1500n)).toBe(true);
  });

  it("closes the cutoff before the lock, not at the lock", () => {
    // This is the whole point. A button live until lockTime spends the user's
    // gas on a transaction the contract was always going to refuse.
    expect(entryOpen(round(), CUTOFF, 1984n)).toBe(true);
    expect(entryOpen(round(), CUTOFF, 1985n)).toBe(false);
    expect(entryClosesAt(round(), CUTOFF)).toBe(1985n);
  });

  it("is closed before the round opens", () => {
    expect(entryOpen(round(), CUTOFF, 999n)).toBe(false);
    expect(entryOpen(round(), CUTOFF, 1000n)).toBe(true);
  });

  it("is closed once the round is no longer Open", () => {
    for (const status of [Status.Locked, Status.Resolved, Status.Void, Status.None]) {
      expect(entryOpen(round({ status }), CUTOFF, 1500n)).toBe(false);
    }
  });

  it("handles a window shorter than the cutoff without going negative", () => {
    // lockTime - entryCutoff underflows conceptually here; entry is simply
    // never open, and nothing should throw.
    const tight = round({ openTime: 1000n, lockTime: 1005n });
    expect(entryOpen(tight, CUTOFF, 1000n)).toBe(false);
  });
});

describe("payout multiples", () => {
  it("is null while a side is empty", () => {
    // Unbounded, and rendering it as a number invites reading it as a payout.
    const oneSided = round({ upPool: 100n, downPool: 0n });
    expect(multipleFor(oneSided, Side.Down, 0n)).toBeNull();
  });

  it("splits an even pool at just under 2x after rake", () => {
    const even = round({ upPool: 100n * WAD, downPool: 100n * WAD });
    const rake = (2n * WAD) / 100n; // 2%
    // 200 total, 4 to rake, 196 over a 100 side.
    expect(multipleFor(even, Side.Up, rake)).toBe((196n * WAD) / 100n);
  });

  it("pays the thin side more", () => {
    const lopsided = round({ upPool: 300n * WAD, downPool: 100n * WAD });
    const up = multipleFor(lopsided, Side.Up, 0n)!;
    const down = multipleFor(lopsided, Side.Down, 0n)!;
    expect(down).toBeGreaterThan(up);
    expect(up).toBe((400n * WAD) / 300n);
    expect(down).toBe(4n * WAD);
  });

  it("takes the rake off the whole pool, not one side", () => {
    const even = round({ upPool: 50n * WAD, downPool: 50n * WAD });
    const noRake = multipleFor(even, Side.Up, 0n)!;
    const withRake = multipleFor(even, Side.Up, WAD / 10n)!;
    expect(withRake).toBe((noRake * 9n) / 10n);
  });
});

describe("thin-side warning", () => {
  it("fires while either side is under the minimum", () => {
    const min = 10n * WAD;
    expect(willVoidOnLock(round({ upPool: 5n * WAD, downPool: 50n * WAD }), min)).toBe(true);
    expect(willVoidOnLock(round({ upPool: 50n * WAD, downPool: 5n * WAD }), min)).toBe(true);
    expect(willVoidOnLock(round({ upPool: 50n * WAD, downPool: 50n * WAD }), min)).toBe(false);
  });

  it("treats exactly the minimum as sufficient", () => {
    // The contract voids below the minimum, not at it.
    const min = 10n * WAD;
    expect(willVoidOnLock(round({ upPool: min, downPool: min }), min)).toBe(false);
  });
});

describe("countdown", () => {
  it("formats minutes and seconds", () => {
    expect(formatCountdown(0n)).toBe("00:00");
    expect(formatCountdown(9n)).toBe("00:09");
    expect(formatCountdown(65n)).toBe("01:05");
    expect(formatCountdown(600n)).toBe("10:00");
  });

  it("adds hours only when there are some", () => {
    expect(formatCountdown(3599n)).toBe("59:59");
    expect(formatCountdown(3600n)).toBe("1:00:00");
    expect(formatCountdown(3661n)).toBe("1:01:01");
  });

  it("clamps at zero rather than counting into the negative", () => {
    // A deadline that has passed shows 00:00, not "-00:07".
    expect(formatCountdown(-7n)).toBe("00:00");
  });
});
