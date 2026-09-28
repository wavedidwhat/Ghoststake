import { describe, expect, it } from "vitest";
import { renderWithMessages } from "@/test/intl";
import type { RoundQuestion } from "@/lib/positions";
import { ResolutionPanel } from "../ResolutionPanel";

/**
 * How a question got its answer (GHO-91). Rendered to markup rather than in a
 * browser: nothing here is interactive, and the whole point of the panel is
 * what it says.
 */

const proposed: RoundQuestion = {
  state: "proposed",
  outcome: "yes",
  proposer: "0x000000000000000000000000000000000000a11c",
  proposedAt: "2026-09-25T10:00:00Z",
  evidenceUri: "https://fifa.com/results/final",
  evidenceDigest: "0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd",
  proposerStake: "0",
  challengeClosesAt: "2026-09-27T10:00:00Z",
};

describe("ResolutionPanel", () => {
  it("shows the claim, the evidence and the digest, not just the answer", () => {
    const html = renderWithMessages(
      <ResolutionPanel question={proposed} decimals={18} symbol="mUSDC" now={new Date("2026-09-26T10:00:00Z")} />,
    );

    // The answer, attributed rather than asserted.
    expect(html).toContain("Someone says the answer is Yes");

    // The evidence and the digest. Without both, the URI can be rewritten
    // after the claim and nobody would know.
    expect(html).toContain("https://fifa.com/results/final");
    expect(html).toContain("0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd");
  });

  it("states how long is left to argue, and what it costs", () => {
    const html = renderWithMessages(
      <ResolutionPanel question={proposed} decimals={18} symbol="mUSDC" now={new Date("2026-09-27T08:00:00Z")} />,
    );
    expect(html).toContain("2h");
    expect(html).toMatch(/bond/);
  });

  it("discloses that the proposer held nothing rather than staying silent", () => {
    // "We checked and they held nothing" is the answer most people want, and
    // an absent row would read as not having looked.
    const html = renderWithMessages(
      <ResolutionPanel question={proposed} decimals={18} symbol="mUSDC" />,
    );
    expect(html).toContain("Their stake here");
    expect(html).toContain("nothing");
  });

  it("shows a held position as a figure", () => {
    const html = renderWithMessages(
      <ResolutionPanel
        question={{ ...proposed, proposerStake: "250000000000000000000" }}
        decimals={18}
        symbol="mUSDC"
      />,
    );
    expect(html).toContain("250.00");
    expect(html).toContain("mUSDC");
  });

  it("does not invent a figure before the decimals are known", () => {
    // GHO-86: a wei value divided by a guessed scale is a wrong number that
    // looks like a right one.
    const html = renderWithMessages(
      <ResolutionPanel question={{ ...proposed, proposerStake: "250000000000000000000" }} />,
    );
    expect(html).not.toContain("250000000000000000000");
    expect(html).toContain("…");
  });

  it("sends nothing to an evidence host about who is reading", () => {
    const html = renderWithMessages(<ResolutionPanel question={proposed} decimals={18} />);
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("says an abandoned question pays nobody", () => {
    const html = renderWithMessages(
      <ResolutionPanel question={{ state: "abandoned", abandonedAt: "2026-09-28T10:00:00Z" }} decimals={18} />,
    );
    expect(html).toMatch(/refunded/);
    expect(html).toMatch(/nobody wins by\s*staying quiet/);
  });
});
