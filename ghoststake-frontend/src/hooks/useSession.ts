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
 * The SIWE session, kept deliberately separate from the wallet connection.
 *
 * Connecting a wallet and proving you own it are different things: the first
 * is the wallet handing over an address, the second is a signature.
 * Everything on-chain needs only the first, so the app stays fully usable
 * unauthenticated and signing is required only for API-side profile data.
 * Prompting for a signature the instant a wallet connects is a pattern users
 * have learned to distrust, and it would gate reads that need no permission.
 */
export function useSession() {
  const connection = useConnection();
  const { signMessageAsync } = useSignMessage();
  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [pending, setPending] = useState<"signing" | "error" | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * A session belongs to one address. If the wallet switches accounts, the
   * stored token proves ownership of an address the user is no longer using,
   * so it stops counting — derived here rather than cleared in an effect,
   * because the token is still valid and still correct for its own address.
   * Switching back should not require signing again.
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
      // Signed verbatim — the server rendered this text and verifies against
      // its own copy, so composing our own would only let the two drift.
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
      // A user dismissing the signature prompt is a normal outcome, not a
      // failure that deserves an error banner.
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
