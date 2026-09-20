import { env } from "./env";

/**
 * The shared fetch wrapper for every read this app makes.
 *
 * It used to also hold the SIWE handshake and a JWT in localStorage. Both are
 * gone (GHO-84): nothing in the app ever read the session, so the token
 * authenticated nothing while still being reachable by any XSS bug. The
 * server side of the handshake is still there and still tested — see
 * `internal/httpx/auth_handlers.go` — it simply has no client until something
 * needs one.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Exported so the read-API clients (activity, rounds) share one place where
 * "the API was unreachable" and "the API said no" are told apart. A second
 * fetch wrapper elsewhere would eventually disagree with this one about which
 * of the two a user is looking at.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${env.apiUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    // Names the two likely causes; the browser only reports "Failed to fetch".
    throw new ApiError(
      `Cannot reach the API at ${env.apiUrl}. Is it running, and is this origin in CORS_ORIGINS?`,
      0,
    );
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(body?.error ?? `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}
