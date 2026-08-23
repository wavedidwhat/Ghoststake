import { env } from "./env";

/**
 * Client for the Go API's SIWE handshake.
 *
 * Note what this file does NOT do: compose the message. The server renders
 * the full SIWE text and keeps its own copy, and verifies against that copy
 * rather than against anything we send back. So the wallet signs the string
 * verbatim and we never parse or rebuild it — if the frontend composed its
 * own message, the two could drift and every signature would fail for
 * reasons invisible from either side.
 *
 * Likewise verify() sends only the nonce and the signature. The address is
 * looked up server-side from the nonce, which is what stops a client from
 * nominating an address it does not control.
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${env.apiUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    // A network-level failure is almost always the API not running locally or
    // the origin missing from CORS_ORIGINS. Say so, rather than surfacing
    // "Failed to fetch" and leaving the developer to guess.
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

export interface NonceResponse {
  nonce: string;
  message: string;
  expiresAt: string;
}

export interface VerifyResponse {
  token: string;
  address: string;
  expiresAt: string;
}

export interface MeResponse {
  address: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export function requestNonce(address: string) {
  return request<NonceResponse>("/api/v1/auth/nonce", {
    method: "POST",
    body: JSON.stringify({ address }),
  });
}

export function verifySignature(nonce: string, signature: string) {
  return request<VerifyResponse>("/api/v1/auth/verify", {
    method: "POST",
    body: JSON.stringify({ nonce, signature }),
  });
}

export function fetchMe(token: string) {
  return request<MeResponse>("/api/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------

const STORAGE_KEY = "ghoststake.session";

export interface StoredSession {
  token: string;
  address: string;
  expiresAt: string;
}

/**
 * The JWT lives in localStorage, which means an XSS bug can read it. That is
 * a real and known trade-off, taken because the alternative — an HttpOnly
 * cookie — needs `AllowCredentials` on the API's CORS config plus CSRF
 * protection, and the backend is currently set up for bearer tokens.
 *
 * What limits the blast radius: this token authenticates reads of profile
 * data only. It cannot move funds. Every value-bearing action is a wallet
 * signature against a contract, which this token has no part in.
 */
export function loadSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as StoredSession;
    // Expired tokens are dropped here rather than being sent and 401'd, so a
    // returning user sees "connect" instead of a flash of a broken session.
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession() {
  window.localStorage.removeItem(STORAGE_KEY);
}
