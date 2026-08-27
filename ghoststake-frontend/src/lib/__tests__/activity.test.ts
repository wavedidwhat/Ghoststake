import { describe, expect, it } from "vitest";
import {
  activityDirection,
  activityLabel,
  shortHash,
  wasLeveraged,
  type ActivityEvent,
} from "../activity";

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "9421133-4-0",
    type: "deposit",
    eventName: "Deposited",
    contract: "CollateralVault",
    amount: "1000000",
    asset: "asset",
    blockNumber: 9_421_133,
    blockTime: "2026-08-27T12:00:00Z",
    txHash: "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    logIndex: 4,
    ...overrides,
  };
}

describe("labels", () => {
  // The vault and the pool both emit `Withdrawn` and they mean completely
  // different things — leaving the vault, and pulling supply back out of the
  // lending pool. The API separates them so this does not have to guess, and
  // this is the assertion that the separation survives to the screen.
  it("does not give the two withdrawals the same label", () => {
    const vault = activityLabel(event({ type: "vault_withdraw", eventName: "Withdrawn" }));
    const pool = activityLabel(event({ type: "pool_withdraw", eventName: "Withdrawn" }));
    expect(vault).not.toBe(pool);
    expect(vault).toBe("Unstaked");
    expect(pool).toBe("Withdrew from pool");
  });

  it("labels every type this build knows", () => {
    const types = [
      "deposit", "vault_withdraw", "supply", "pool_withdraw", "borrow", "repay",
      "yield", "lien_settled", "liquidation", "share_transfer_in",
      "share_transfer_out", "position", "claim",
    ] as const;
    for (const type of types) {
      const label = activityLabel(event({ type }));
      expect(label, type).not.toBe(type);
      expect(label.length, type).toBeGreaterThan(0);
    }
  });

  // The server falls back to a raw event name for anything it does not
  // recognise, and a client that renders that as "Unknown" turns a new
  // feature into what looks like corrupt data.
  it("shows an unrecognised type as the event that produced it", () => {
    expect(activityLabel(event({ type: "RoundVoided", eventName: "RoundVoided" }))).toBe(
      "RoundVoided",
    );
  });
});

describe("direction", () => {
  it("puts value leaving the wallet on one side and arriving on the other", () => {
    expect(activityDirection(event({ type: "deposit" }))).toBe("out");
    expect(activityDirection(event({ type: "supply" }))).toBe("out");
    expect(activityDirection(event({ type: "repay" }))).toBe("out");
    expect(activityDirection(event({ type: "position" }))).toBe("out");

    expect(activityDirection(event({ type: "borrow" }))).toBe("in");
    expect(activityDirection(event({ type: "claim" }))).toBe("in");
    expect(activityDirection(event({ type: "vault_withdraw" }))).toBe("in");
    expect(activityDirection(event({ type: "pool_withdraw" }))).toBe("in");
  });

  // A yield settlement and a lien settlement move a figure between books
  // inside the protocol. Signing them like a transfer would show money
  // arriving that the user cannot spend.
  it("treats internal checkpoints as neither", () => {
    expect(activityDirection(event({ type: "yield" }))).toBe("neutral");
    expect(activityDirection(event({ type: "lien_settled" }))).toBe("neutral");
  });

  it("falls back to neutral rather than guessing", () => {
    expect(activityDirection(event({ type: "SomethingNew" }))).toBe("neutral");
  });

  // The two sides of one share transfer are one log, split into two rows.
  // Reading them the same way makes an outgoing transfer look like money
  // arriving.
  it("keeps the two sides of a share transfer apart", () => {
    expect(activityDirection(event({ type: "share_transfer_in" }))).toBe("in");
    expect(activityDirection(event({ type: "share_transfer_out" }))).toBe("out");
  });
});

describe("leverage", () => {
  const user = "0x000000000000000000000000000000000000A11c";
  const router = "0x00000000000000000000000000000000000R0000".replace("R", "b");

  // The funder is the only surviving evidence: the router paid, not the user.
  it("spots a position opened with borrowed funds", () => {
    const position = event({ type: "position", data: { funder: router } });
    expect(wasLeveraged(position, user)).toBe(true);
  });

  it("does not call a cash position leveraged", () => {
    const position = event({ type: "position", data: { funder: user } });
    expect(wasLeveraged(position, user)).toBe(false);
  });

  // Case is not identity for an address. A checksummed funder compared
  // against a lowercase wallet would mark every cash position as leveraged.
  it("compares addresses without regard to case", () => {
    const position = event({ type: "position", data: { funder: user.toLowerCase() } });
    expect(wasLeveraged(position, user.toUpperCase())).toBe(false);
  });

  it("says nothing about rows that are not positions", () => {
    expect(wasLeveraged(event({ type: "deposit", data: { funder: router } }), user)).toBe(false);
  });
});

describe("shortHash", () => {
  it("keeps both ends so a hash stays recognisable", () => {
    expect(shortHash("0xabcdef0123456789", 6, 4)).toBe("0xabcd…6789");
  });

  it("leaves something already short alone", () => {
    expect(shortHash("0xabcd")).toBe("0xabcd");
  });
});
