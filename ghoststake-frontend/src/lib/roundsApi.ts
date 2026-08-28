import { request } from "./api";
import type { PositionRound } from "./positions";

/**
 * The client for `GET /api/v1/rounds`.
 *
 * Used only from the server, during `generateMetadata` — the interactive pages
 * read the chain, for the reason written into `useRounds`: their numbers feed a
 * transaction somebody is about to sign, and the API is deliberately a few
 * blocks behind.
 *
 * A title is the opposite case. It is read by a crawler with no wallet and no
 * JavaScript, it describes a round rather than quoting one, and being a block
 * stale in it costs nothing.
 */
export interface RoundsResponse {
  chainId: number;
  indexedBlock: number;
  asOf: string;
  rounds: PositionRound[];
}

export function fetchRounds(
  options: { market?: string; limit?: number } = {},
): Promise<RoundsResponse> {
  const params = new URLSearchParams();
  if (options.market) params.set("market", options.market);
  if (options.limit) params.set("limit", String(options.limit));

  const query = params.toString();
  return request<RoundsResponse>(`/api/v1/rounds${query ? `?${query}` : ""}`);
}
