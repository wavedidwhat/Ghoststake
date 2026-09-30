import { ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError } from "viem";
import { describe, expect, it } from "vitest";
import { translate } from "@/test/intl";
import { amountProblem, parseAmount } from "../amount";
import { formatFor } from "../format";
import { isRevert } from "../probe";

const { formatAmount } = formatFor("en");
import { mockUSDCAbi } from "../abis";

/**
 * GHO-86: three places where a read that had not resolved, or had failed,
 * produced something worse than an error. All three were silent by
 * construction, which is why none had a test.
 */
describe("a figure never borrows a scale", () => {
  it("does not default the scale when it is unknown", () => {
    // `formatAmount` used to default `decimals` to 18, so an unresolved read
    // (`position.decimals!` while still undefined) formatted a 6-decimal
    // balance of 10,000 as 0.0000. The type now requires a scale; at runtime
    // an undefined one is refused rather than guessed.
    const tenThousandUsdc = 10_000n * 10n ** 6n;
    expect(formatAmount(tenThousandUsdc, 6, 2)).toBe("10,000.00");
    expect(() => formatAmount(tenThousandUsdc, undefined as unknown as number, 2)).toThrow();
  });
});

describe("an over-precise amount says so", () => {
  it("names the token's precision and the input's", () => {
    const problem = (input: string, decimals: number) => {
      const found = amountProblem(input, decimals);
      return found && translate(found);
    };
    expect(problem("1.1234567", 6)).toBe("This token has 6 decimal places; that amount has 7.");
    expect(problem("1.5", 0)).toBe("This token has no decimal places.");
    // A plural now, where the template read "1 decimal places" (GHO-119).
    expect(problem("1.25", 1)).toBe("This token has 1 decimal place; that amount has 2.");
  });

  it("is quiet for a valid amount and for one still being typed", () => {
    for (const input of ["", ".", "1", "1.", "1.123456", "0.5"]) {
      expect(amountProblem(input, 6)).toBeNull();
    }
  });

  it("agrees with parseAmount about what is usable", () => {
    // The message and the refusal come from the same rule. If these ever
    // disagreed, a field would complain about an amount the form accepts, or
    // accept silently one the form refuses — the original bug.
    for (const input of ["1.1234567", "1.123456", "10", "0.000001", "0.0000001"]) {
      expect(amountProblem(input, 6) === null).toBe(parseAmount(input, 6) !== null);
    }
  });
});

describe("a failed probe is not an answer", () => {
  const args = { abi: mockUSDCAbi, functionName: "mint" as const, args: [] };

  it("reads a revert as the contract saying no", () => {
    const revert = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi: mockUSDCAbi, functionName: "mint" }),
      { ...args, contractAddress: "0x0000000000000000000000000000000000000001" },
    );
    expect(isRevert(revert)).toBe(true);
  });

  it("reads a rate limit or an unreachable RPC as no answer at all", () => {
    // The 2026-09-19 case: a 429 during the probe hid the faucet for the
    // session, because any error was taken to mean "a real ERC-20".
    const rateLimited = new ContractFunctionExecutionError(
      new HttpRequestError({ url: "https://rpc.example", status: 429 }),
      { ...args, contractAddress: "0x0000000000000000000000000000000000000001" },
    );
    expect(isRevert(rateLimited)).toBe(false);
    expect(isRevert(new Error("fetch failed"))).toBe(false);
    expect(isRevert(undefined)).toBe(false);
  });
});
