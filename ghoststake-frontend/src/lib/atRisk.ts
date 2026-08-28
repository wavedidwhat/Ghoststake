import { request } from "./api";

/**
 * The client for `GET /api/v1/positions/at-risk` — borrowers ordered by how
 * close they are to liquidation.
 *
 * The endpoint GHO-42 exists for, and the gap it closes is worth stating.
 * `liquidate` is permissionless, and that is load-bearing: the protocol stays
 * solvent because anyone can close an underwater position and take the bonus.
 * But every other view in the system is per-address — `isLiquidatable(who)`,
 * `/health/{address}` — so a liquidator had to already know whose position was
 * underwater before they could act on it. The incentive existed, the mechanism
 * existed, and the discovery step did not.
 *
 * A frontend cannot fill that gap from the chain: there is no borrower
 * enumeration on the pool, and reconstructing one means reading every Borrowed
 * and Repaid log, which is exactly the cost the indexer was built to remove.
 */

/** Every uint256 crosses the wire as a decimal string. Parse with `BigInt`. */
export interface AtRiskPosition {
  address: string;
  collateral: string;
  /**
   * Includes interest pending since the pool last accrued — a liquidator's
   * transaction accrues before it reads the health factor, so this is the debt
   * they would actually find, not the smaller one the contract's view returns
   * until somebody pokes it.
   */
  debt: string;
  /** WAD. Below 1e18 is liquidatable. */
  healthFactor: string;
  ltv: string;
  band: "none" | "safe" | "caution" | "danger" | (string & {});
  liquidatable: boolean;

  /** The most one call may clear. */
  maxRepay: string;
  /** Collateral that repayment takes, bonus included, capped at what exists. */
  seized: string;
  /** Seized less repaid. Zero, never negative — see `profitable`. */
  bonus: string;
  /**
   * Whether a rational liquidator would call at all.
   *
   * False is not an edge case. Past the point where collateral covers debt
   * plus the bonus, the caller is out of pocket, which is precisely why those
   * positions sit unliquidated and become bad debt.
   */
  profitable: boolean;
  /** The close factor has lifted, so one call clears the whole lien. */
  fullLiquidation: boolean;
  /**
   * Owes more than it holds. No liquidation can close it; `writeOffBadDebt`
   * can, and pays nothing for doing so (GHO-45).
   */
  writeOffCandidate: boolean;
}

export interface AtRiskResponse {
  chainId: number;
  /** The chain block every figure was read at. */
  block: number;
  /**
   * How far the ledger has read. It bounds who can appear at all — a borrower
   * whose first draw is newer than this has not been seen — while every figure
   * comes from `block`, which is the head.
   */
  indexedBlock: number;
  asOf: string;
  scanned: number;
  /** The scan cap was reached; there may be more. */
  truncated: boolean;
  positions: AtRiskPosition[];
}

export function fetchAtRisk(limit?: number): Promise<AtRiskResponse> {
  const query = limit ? `?limit=${limit}` : "";
  return request<AtRiskResponse>(`/api/v1/positions/at-risk${query}`);
}

/**
 * What a row is actually asking the reader to do.
 *
 * Three states, not two, and collapsing them would be the one mistake this
 * page can make that costs somebody money:
 *
 * - `liquidate` — underwater and profitable. Call it and take the bonus.
 * - `write-off` — owes more than it holds. No liquidation comes out ahead;
 *   `writeOffBadDebt` closes it and pays nothing.
 * - `watch` — not liquidatable yet. Nothing to do but look.
 *
 * A row that is liquidatable but unprofitable and *not* yet a write-off
 * candidate resolves to `watch`: the maths says a caller would lose, and there
 * is no other call to offer.
 */
export type Action = "liquidate" | "write-off" | "watch";

export function actionFor(position: AtRiskPosition): Action {
  if (position.writeOffCandidate) return "write-off";
  if (position.liquidatable && position.profitable) return "liquidate";
  return "watch";
}

/** Seized less repaid, as a signed figure — negative where the caller loses. */
export function netToLiquidator(position: AtRiskPosition): bigint {
  return BigInt(position.seized) - BigInt(position.maxRepay);
}
