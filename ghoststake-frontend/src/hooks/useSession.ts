"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useConnection, useSignMessage } from "wagmi";
import { ApiError, requestNonce, verifySignature, type StoredSession } from "@/lib/api";
import {
  clearStoredSession,
  getServerSnapshot,
  getSnapshot,
  setStoredSession,
  subscribe,
} from "@/lib/session-store";

/** Exported so the button can type its own props against it rather than restate the union. */
export type SessionStatus = "anonymous" | "signing" | "authenticated" | "error";

/**
 * The SIWE session, kept separate from the wallet connection.
 *
 * A connection supplies an address; a signature proves ownership of it.
 * Contract reads need only the first, so signing stays opt-in and is required
 * only for API-side profile data rather than prompted on connect.
 */
export function useSession() {
  const connection = useConnection();
  const { signMessageAsync } = useSignMessage();
  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [pending, setPending] = useState<"signing" | "error" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every attempt, so a retry gets its own stall window rather than
  // inheriting the last one's verdict. See useStalled.
  const [attempt, setAttempt] = useState(0);
  // Which attempt is live. A cancelled attempt's promise is still running —
  // there is no way to withdraw a request a wallet has already taken — so when
  // it finally settles it must not write over the state of a newer one, or of
  // a user who has given up. Compared by value rather than aborted, because
  // signMessageAsync takes no AbortSignal.
  const live = useRef(0);

  /**
   * A session belongs to one address, so it stops applying when the wallet
   * switches accounts. Derived rather than cleared: the token is still valid
   * for its own address, and switching back should not require signing again.
   */
  const session =
    stored && connection.address &&
    stored.address.toLowerCase() === connection.address.toLowerCase()
      ? stored
      : null;

  /**
   * Expiry, noticed while the tab is open.
   *
   * `loadSession` drops an expired token, but it only runs on load and the
   * snapshot is cached, so a tab left open past `expiresAt` went on offering
   * "Sign out" while every API call behind it 401'd (GHO-77).
   *
   * One timer at the known moment rather than a per-second tick: expiry is a
   * single transition, and ticking to watch for it would re-render this hook's
   * consumers — the header among them — thousands of times to catch it once.
   * Clearing storage rather than deriving `null` also signs the other tabs out,
   * through the `storage` listener in the store.
   */
  useEffect(() => {
    if (!stored) return;
    const remaining = Date.parse(stored.expiresAt) - Date.now();
    if (remaining <= 0) {
      clearStoredSession();
      return;
    }
    // setTimeout truncates past 2^31-1ms and would fire at once, turning a
    // far-future expiry into an immediate sign-out. Nothing issues a token that
    // long-lived; if anything ever does, the next load handles it instead.
    if (remaining > 2_147_483_647) return;
    const timer = setTimeout(clearStoredSession, remaining);
    return () => clearTimeout(timer);
  }, [stored]);

  const status: SessionStatus = pending ?? (session ? "authenticated" : "anonymous");

  const signIn = useCallback(async () => {
    if (!connection.address) return;
    const mine = live.current + 1;
    live.current = mine;
    setAttempt((n) => n + 1);
    setPending("signing");
    setError(null);
    try {
      const challenge = await requestNonce(connection.address);
      // Signed verbatim: the server verifies against its own stored copy.
      const signature = await signMessageAsync({ message: challenge.message });
      const verified = await verifySignature(challenge.nonce, signature);
      const next: StoredSession = {
        token: verified.token,
        address: verified.address,
        expiresAt: verified.expiresAt,
      };
      if (live.current !== mine) return;
      setStoredSession(next);
      setPending(null);
    } catch (cause) {
      if (live.current !== mine) return;
      // Dismissing the wallet prompt is a normal outcome, not an error state.
      const rejected = cause instanceof Error && /user rejected|denied/i.test(cause.message);
      if (rejected) {
        setPending(null);
        return;
      }
      setError(cause instanceof ApiError ? cause.message : "Could not complete sign-in.");
      setPending("error");
    }
  }, [connection.address, signMessageAsync]);

  const signOut = useCallback(() => {
    clearStoredSession();
    live.current += 1;
    setPending(null);
    setError(null);
  }, []);

  /**
   * Give up on a wallet that is not going to answer.
   *
   * It cannot cancel the request — the wallet has it, and `signMessageAsync`
   * takes no AbortSignal — so this abandons it instead: the attempt is retired,
   * and if it ever resolves the guards above drop it on the floor. The honest
   * framing for the user is "stop waiting", not "cancel", and the copy says so.
   */
  const stopWaiting = useCallback(() => {
    live.current += 1;
    setPending(null);
    setError(null);
  }, []);

  return { session, status, error, attempt, signIn, signOut, stopWaiting };
}
