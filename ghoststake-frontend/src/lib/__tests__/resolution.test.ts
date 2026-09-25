import { describe, expect, it } from "vitest";
import type { RoundQuestion } from "../positions";
import {
  challengeWindow,
  claimFavoursProposer,
  outcomeLabel,
  proposerInterest,
  questionHeadline,
} from "../resolution";

const base: RoundQuestion = { state: "open" };

describe("questionHeadline", () => {
  it("does not claim an answer before anyone has given one", () => {
    expect(questionHeadline(base)).toBe("Nobody has said what happened yet");
  });

  it("attributes a claim to somebody rather than stating it as fact", () => {
    // "The answer is Yes" while the window is still open would be the
    // operator call this whole mechanism replaces.
    const headline = questionHeadline({ state: "proposed", outcome: "yes" });
    expect(headline).toBe("Someone says the answer is Yes");
    expect(headline).not.toBe("The answer is Yes");
  });

  it("states it as fact once it is final", () => {
    expect(questionHeadline({ state: "final", outcome: "no" })).toBe("The answer is No");
  });

  it("says an abandoned question is over, not still coming", () => {
    // "Unresolved" reads as "still being decided", and somebody would wait
    // for a ruling that is never coming. The bonds are back and the round
    // refunds.
    const headline = questionHeadline({ state: "abandoned" });
    expect(headline).toMatch(/refunded/);
    expect(headline).not.toMatch(/waiting|pending|soon/i);
  });
});

describe("challengeWindow", () => {
  const proposed: RoundQuestion = {
    state: "proposed",
    outcome: "yes",
    challengeClosesAt: "2026-09-25T12:00:00Z",
  };

  it("counts down to the deadline", () => {
    const { open, secondsLeft } = challengeWindow(proposed, new Date("2026-09-25T11:59:00Z"));
    expect(open).toBe(true);
    expect(secondsLeft).toBe(60);
  });

  it("never shows a negative countdown past the deadline", () => {
    // The claim is final in substance but `finalise` is still somebody's
    // transaction, so the state is still "proposed" for a while. "-3h left"
    // and "3h left" would both be lies.
    const { open, secondsLeft } = challengeWindow(proposed, new Date("2026-09-25T15:00:00Z"));
    expect(open).toBe(false);
    expect(secondsLeft).toBe(0);
  });

  it("is closed once a claim has been argued with", () => {
    expect(challengeWindow({ ...proposed, state: "challenged" }, new Date()).open).toBe(false);
  });

  it("holds off until the caller has a clock", () => {
    // `now` is undefined on the server and on the first client render.
    // Computing a countdown here is a hydration mismatch on every question
    // on screen.
    expect(challengeWindow(proposed, undefined)).toEqual({ open: true, secondsLeft: null });
  });
});

describe("proposerInterest", () => {
  it("tells nothing-held apart from could-not-be-read", () => {
    // The market is read with a raw staticcall that records zero when it
    // reverts, so "0" can mean either — but the API omits the field when it
    // has nothing at all, and those two must not render the same. "They held
    // nothing" is a finding; "we could not look" is not.
    expect(proposerInterest({ ...base, proposerStake: "0" })).toBe("none");
    expect(proposerInterest({ ...base, proposerStake: "1" })).toBe("held");
    expect(proposerInterest(base)).toBe("unknown");
    expect(proposerInterest({ ...base, proposerStake: "not a number" })).toBe("unknown");
  });
});

describe("claimFavoursProposer", () => {
  it("only says so when the side is actually known", () => {
    const q: RoundQuestion = { state: "proposed", outcome: "yes" };
    expect(claimFavoursProposer(q, "yes")).toBe(true);
    expect(claimFavoursProposer(q, "no")).toBe(false);
    // Which side the proposer held is not on chain — `proposerStake` is
    // their whole stake in the round — so an unknown side must not be
    // rendered as an accusation.
    expect(claimFavoursProposer(q, undefined)).toBe(false);
  });
});

describe("outcomeLabel", () => {
  it("has no answer for a question nobody has answered", () => {
    expect(outcomeLabel("none")).toBeNull();
    expect(outcomeLabel(undefined)).toBeNull();
    expect(outcomeLabel("yes")).toBe("Yes");
    expect(outcomeLabel("no")).toBe("No");
  });
});
