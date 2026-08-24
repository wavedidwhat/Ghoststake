"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { useConnection, useSignMessage } from "wagmi";
import { ApiError, requestNonce, verifySignature, type StoredSession } from "@/lib/api";
import {
  clearStoredSession,
  getServerSnapshot,
  getSnapshot,
  setStoredSession,
  subscribe,
} from "@/lib/session-store";

type Status = "anonymous" | "signing" | "authenticated" | "error";

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

  const status: Status = pending ?? (session ? "authenticated" : "anonymous");

  const signIn = useCallback(async () => {
    if (!connection.address) return;
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
      setStoredSession(next);
      setPending(null);
    } catch (cause) {
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
    setPending(null);
    setError(null);
  }, []);

  return { session, status, error, signIn, signOut };
}
