import { describe, expect, it } from "vitest";
import {
  byRecency,
  isUnclaimed,
  netOf,
  outcomeOf,
  sideTaken,
  type Position,
  type PositionRound,
} from "../positions";

function round(over: Partial<PositionRound> = {}): PositionRound {
  return {
    market: "0x000000000000000000000000000000000000003a",
    id: 7,
    status: "resolved",
    phase: "resolved",
    entryOpen: false,
    openTime: "2026-08-01T10:00:00Z",
    lockTime: "2026-08-01T10:05:00Z",
    closeTime: "2026-08-01T10:10:00Z",
    upPool: "300",
    downPool: "100",
    totalPool: "400",
    upOdds: "0",
    downOdds: "0",
    lockPrice: "100",
    closePrice: "110",
    winner: "up",
    rakeTaken: "0",
    lastBlock: 500,
    ...over,
  };
}

function position(over: Partial<Position> = {}): Position {
  return {
    round: round(),
    upStake: "100",
    downStake: "0",
    totalStake: "100",
    claimable: "133",
    claimed: false,
    claimedAmount: "0",
    leveraged: false,
    openedAt: "2026-08-01T10:01:00Z",
    ...over,
  };
}

describe("outcomeOf", () => {
  it("is a win when the account held the winning side", () => {
    expect(outcomeOf(position())).toBe("won");
  });

  it("is a loss when the account held only the losing side", () => {
    expect(outcomeOf(position({ upStake: "0", downStake: "100", claimable: "0" }))).toBe("lost");
  });

  // Hedging is legal and does happen, so the winning side is what decides —
  // not "which side did they take", which has no answer here.
  it("is a win when both sides were held and one of them won", () => {
    expect(outcomeOf(position({ upStake: "60", downStake: "40", totalStake: "100" }))).toBe("won");
  });

  // A void is its own outcome. Calling it a win because money came back
  // overstates it; calling it a loss lies about a refund.
  it("is void regardless of which side was held", () => {
    const voided = position({ round: round({ status: "void", winner: undefined }) });
    expect(outcomeOf(voided)).toBe("void");
    expect(outcomeOf({ ...voided, upStake: "0", downStake: "100" })).toBe("void");
  });

  it("is open while the round has not settled", () => {
    expect(outcomeOf(position({ round: round({ status: "open", winner: undefined }) }))).toBe(
      "open",
    );
    expect(outcomeOf(position({ round: round({ status: "locked", winner: undefined }) }))).toBe(
      "open",
    );
  });
});

describe("netOf", () => {
  it("is the payout less the stake on a win", () => {
    expect(netOf(position())).toBe(33n);
  });

  it("is the whole stake, negative, on a loss", () => {
    expect(netOf(position({ upStake: "0", downStake: "100", claimable: "0" }))).toBe(-100n);
  });

  // The trap this exists to avoid: `claimable` goes to zero once claimed, so a
  // net read from it alone reports every collected win as a total loss — the
  // worst possible direction for that error.
  it("reads the claimed amount once the win has been collected", () => {
    const collected = position({ claimed: true, claimable: "0", claimedAmount: "133" });
    expect(netOf(collected)).toBe(33n);
  });

  it("is zero on a void, because the stake came back whole", () => {
    const voided = position({
      round: round({ status: "void", winner: undefined }),
      claimable: "100",
    });
    expect(netOf(voided)).toBe(0n);
  });

  // An unsettled round has no result. Returning zero here would render as a
  // break-even that the user might read as final.
  it("has no answer while the round is still running", () => {
    expect(netOf(position({ round: round({ status: "locked", winner: undefined }) }))).toBeNull();
  });
});

describe("isUnclaimed", () => {
  it("is true for a win nobody has collected", () => {
    expect(isUnclaimed(position())).toBe(true);
  });

  it("is false once claimed", () => {
    expect(isUnclaimed(position({ claimed: true, claimable: "0", claimedAmount: "133" }))).toBe(
      false,
    );
  });

  it("is false for a loss, which has nothing to collect", () => {
    expect(isUnclaimed(position({ upStake: "0", downStake: "100", claimable: "0" }))).toBe(false);
  });
});

describe("sideTaken", () => {
  it("names the single side held", () => {
    expect(sideTaken(position())).toBe("up");
    expect(sideTaken(position({ upStake: "0", downStake: "100" }))).toBe("down");
  });

  it("reports both when the account entered each side", () => {
    expect(sideTaken(position({ upStake: "60", downStake: "40" }))).toBe("both");
  });
});

describe("byRecency", () => {
  // Sorted on the block, not the round id: ids restart at 1 in every market,
  // so round 3 of a market deployed today is newer than round 900 of one
  // deployed in June.
  it("orders across markets by the block the round was last touched at", () => {
    const older = position({ round: round({ id: 900, lastBlock: 100 }) });
    const newer = position({
      round: round({ id: 3, market: "0x0000000000000000000000000000000000000b0b", lastBlock: 900 }),
    });
    expect([older, newer].sort(byRecency).map((p) => p.round.id)).toEqual([3, 900]);
  });
});

// A resolved round always names its winner — the same event sets both — but
// the field is `omitempty`, so a partial payload can arrive without one. The
// naive reading is "held neither winning side", which renders as a loss, and
// telling someone they lost while they hold a payout is the worst available
// guess. It would also disagree with the server, whose `Claimable` treats any
// winner that is not "up" as "down" and can still compute a payout.
describe("outcomeOf without a winner on the wire", () => {
  const noWinner = (over: Partial<Position> = {}) =>
    position({ round: round({ status: "resolved", winner: undefined }), ...over });

  it("falls back to whether anything came back, rather than assuming a loss", () => {
    expect(outcomeOf(noWinner({ claimable: "133" }))).toBe("won");
    expect(outcomeOf(noWinner({ claimed: true, claimable: "0", claimedAmount: "133" }))).toBe(
      "won",
    );
  });

  it("is still a loss when nothing came back", () => {
    expect(outcomeOf(noWinner({ claimable: "0" }))).toBe("lost");
  });
});
