import { env } from "./env";

/**
 * Client for the Go API's SIWE handshake.
 *
 * The server renders the SIWE message and verifies against its own stored
 * copy, so this file never composes or parses one — the wallet signs the
 * string verbatim. `verify` sends only the nonce and signature; the address
 * is resolved server-side from the nonce, so a client cannot nominate one.
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
 * The JWT is in localStorage, so an XSS bug can read it. Accepted because the
 * token only authenticates profile reads — moving funds requires a wallet
 * signature it plays no part in. Revisit if the API gains write endpoints.
 */
function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.token === "string" &&
    typeof candidate.address === "string" &&
    typeof candidate.expiresAt === "string" &&
    !Number.isNaN(Date.parse(candidate.expiresAt))
  );
}

export function loadSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    // Validated, not just cast. localStorage is writable by the user and by
    // any extension, so a malformed entry is reachable without an exploit —
    // and an unchecked cast turns one into a TypeError during render.
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredSession(parsed)) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    // Dropped here rather than sent and 401'd, so a returning user sees the
    // signed-out state instead of a session that breaks on first use.
    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
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
