import { describe, expect, it } from "vitest";
import { actionFor, netToLiquidator, type AtRiskPosition } from "../atRisk";

function position(over: Partial<AtRiskPosition> = {}): AtRiskPosition {
  return {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    collateral: "10000000000",
    debt: "9327983023",
    healthFactor: "857634494003087981",
    ltv: "932798302300000000",
    band: "danger",
    liquidatable: true,
    maxRepay: "4663991511",
    seized: "4897191086",
    bonus: "233199575",
    profitable: true,
    fullLiquidation: false,
    writeOffCandidate: false,
    ...over,
  };
}

// The one mistake this page can make that costs somebody money is offering a
// call that loses. Three states, never two.
describe("actionFor", () => {
  it("offers a liquidation when the position is underwater and profitable", () => {
    expect(actionFor(position())).toBe("liquidate");
  });

  it("offers a write-off when the position owes more than it holds", () => {
    // The GHO-45 case. No liquidation comes out ahead here, so a Liquidate
    // button would be sending the reader to lose money.
    expect(
      actionFor(position({ writeOffCandidate: true, profitable: false, seized: "5000000000" })),
    ).toBe("write-off");
  });

  it("prefers the write-off even when the quote still reads as profitable", () => {
    // Belt and braces: `profitable` is computed from a capped seizure and
    // `writeOffCandidate` from the debt against the collateral. If the two
    // ever disagreed, the safe reading is the one that does not spend money.
    expect(actionFor(position({ writeOffCandidate: true, profitable: true }))).toBe("write-off");
  });

  it("watches a healthy position", () => {
    expect(actionFor(position({ liquidatable: false, profitable: false }))).toBe("watch");
  });

  // Underwater, no profit in it, and not yet beyond recovery. There is no call
  // worth making, and the absence of a button is the information.
  it("watches an underwater position nobody would profit from", () => {
    expect(actionFor(position({ liquidatable: true, profitable: false }))).toBe("watch");
  });
});

describe("netToLiquidator", () => {
  it("is the bonus on a profitable liquidation", () => {
    expect(netToLiquidator(position())).toBe(233199575n);
  });

  // Signed, unlike the API's `bonus`, which floors at zero. A row showing a
  // loss as "0" would read as breaking even.
  it("is negative when the seizure cannot cover the repayment", () => {
    expect(netToLiquidator(position({ maxRepay: "10000000000", seized: "5000000000" }))).toBe(
      -5000000000n,
    );
  });
});
