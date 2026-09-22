import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from "viem";

/**
 * Whether a failed call was the contract saying no, as opposed to the call
 * never getting an answer (GHO-86).
 *
 * The two mean opposite things to anything that probes by simulating: a
 * revert is an answer ("this token has no `mint`"), and a transport failure —
 * a 429, a timeout, an unreachable RPC — is the absence of one. Treating them
 * alike is how one rate-limited probe hid the testnet faucet for a whole
 * session on 2026-09-19.
 *
 * Checked against the chain rather than assumed: a `mint` simulated against a
 * contract without one walks to ContractFunctionRevertedError, and the same
 * call against an unreachable endpoint walks to HttpRequestError with no
 * revert anywhere in the chain.
 */
export function isRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return Boolean(
    error.walk(
      (e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError,
    ),
  );
}
