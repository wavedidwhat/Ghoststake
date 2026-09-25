import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Phase, Status, type Round } from "@/lib/rounds";
import { RoundCard } from "../RoundCard";

/**
 * What the card says about the price, the strike and who decides the round
 * (GHO-64).
 *
 * These are assertions about *wording*, which is deliberate. Every bug this
 * file guards against typechecked cleanly and rendered without error — they
 * were sentences that were simply untrue, and the only thing that catches
 * those is reading what the component actually says.
 */

const OPEN_AT = 1_790_330_000n;

function round(over: Partial<Round> = {}): Round {
  return {
    openTime: OPEN_AT,
    lockTime: OPEN_AT + 1800n,
    closeTime: OPEN_AT + 3600n,
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

const base = {
  decimals: 6,
  symbol: "mUSDC",
  entryCutoff: 15n,
  minSidePool: 0n,
  rake: 200n,
  feed: "ETH / USD",
  feedAddress: "0x694AA1769357215DE4FAC081bf1f309aDC325306" as const,
  now: OPEN_AT + 600n,
  id: 418n,
};

function render(props: Record<string, unknown>) {
  // @ts-expect-error — the card takes more props than these tests care about,
  // and listing them all would obscure which one each case is actually about.
  return renderToStaticMarkup(<RoundCard {...base} {...props} />);
}

describe("the settlement line", () => {
  it("names the feed, the second and invites the reader to check it", () => {
    const html = render({ round: round(), phase: Phase.Open });

    expect(html).toContain("Settles on the");
    expect(html).toContain("ETH / USD");
    expect(html).toContain("Anyone can check it");
    // The close time, in UTC, to the second — this is the number somebody
    // would look up on the feed.
    expect(html).toContain("UTC");
    // And a way to go and look.
    expect(html).toContain("0x694AA1769357215DE4FAC081bf1f309aDC325306");
  });

  /**
   * A void round was cancelled and refunded; the feed decided nothing. Round
   * 417 on Sepolia voided with one side empty, and an earlier draft of this
   * component told its holder it had "settled on the Chainlink ETH / USD
   * price" — false, on the one line whose whole purpose is to be checked.
   */
  it("says nothing at all about settlement on a round that was voided", () => {
    const html = render({
      round: round({ status: Status.Void, lockPrice: 2_700n * 10n ** 18n }),
      phase: Phase.Void,
    });

    expect(html).not.toContain("Settles on the");
    expect(html).not.toContain("Settled on the");
  });

  it("uses the past tense once a round has actually resolved", () => {
    const html = render({
      round: round({
        status: Status.Resolved,
        lockPrice: 2_700n * 10n ** 18n,
        closePrice: 2_750n * 10n ** 18n,
      }),
      phase: Phase.Resolved,
    });

    expect(html).toContain("Settled on the");
    expect(html).not.toContain("Settles on the");
  });

  /** A question is decided by a named arbiter against written criteria. */
  it("is absent on a market settled by a claim rather than a price", () => {
    const html = render({ round: round(), phase: Phase.Open, isQuestion: true });

    expect(html).not.toContain("Settles on the");
  });
});

describe("a round whose strike is not set yet", () => {
  /**
   * Markets deployed before GHO-79 capture the level at lock, not at open,
   * and the live Sepolia market is one of them. For the whole entry window
   * there is genuinely nothing to compare a price against, and saying so is
   * the difference between a phase and a missing number.
   */
  it("says the start price is set when entry closes", () => {
    const html = render({ round: round(), phase: Phase.Open });

    expect(html).toContain("Start price is set when entry closes");
  });

  it("does not still promise a future deadline once entry has closed", () => {
    const html = render({ round: round(), phase: Phase.Cutoff });

    expect(html).not.toContain("when entry closes");
    expect(html).toContain("Start price is being set now");
  });

  /** A round that has a strike has nothing to wait for. */
  it("says none of that once the strike exists", () => {
    const html = render({
      round: round({ lockPrice: 2_700n * 10n ** 18n }),
      phase: Phase.Open,
    });

    expect(html).not.toContain("Start price is set when entry closes");
    expect(html).not.toContain("Start price is being set now");
  });

  /** A question has no strike and is not waiting for one. */
  it("says none of that on a question", () => {
    const html = render({ round: round(), phase: Phase.Open, isQuestion: true });

    expect(html).not.toContain("Start price is");
  });
});
