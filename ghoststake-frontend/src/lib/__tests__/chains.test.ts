import { describe, expect, it } from "vitest";
import { chainShortName } from "../chains";

describe("chainShortName (GHO-127)", () => {
  it("drops a trailing Testnet, which the badge says in its own chip", () => {
    expect(chainShortName({ name: "Robinhood Chain Testnet", testnet: true })).toBe("Robinhood Chain");
  });

  it("leaves a testnet alone when its name does not say so", () => {
    expect(chainShortName({ name: "Sepolia", testnet: true })).toBe("Sepolia");
    expect(chainShortName({ name: "Arbitrum Sepolia", testnet: true })).toBe("Arbitrum Sepolia");
  });

  it("never trims a mainnet, whatever it is called", () => {
    expect(chainShortName({ name: "Robinhood Chain" })).toBe("Robinhood Chain");
    expect(chainShortName({ name: "Something Testnet" })).toBe("Something Testnet");
  });

  it("does not trim a name down to nothing", () => {
    expect(chainShortName({ name: "Testnet", testnet: true })).toBe("Testnet");
  });
});
