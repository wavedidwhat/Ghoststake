"use client";

import { useConnection, useConnect, useConnectors, useDisconnect } from "wagmi";
import { shortenAddress } from "@/lib/format";
import { useSession } from "@/hooks/useSession";

/**
 * Connect, disconnect, and the optional SIWE sign-in.
 *
 * wagmi 3 has no `useAccount`: connection state is `useConnection`, and
 * `useConnect().connect` / `.connectors` are deprecated in favour of
 * `mutate` and `useConnectors`.
 */
export function ConnectButton() {
  const connection = useConnection();
  const connectors = useConnectors();
  const { mutate: connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { status: sessionStatus, signIn, signOut } = useSession();

  if (connection.status === "reconnecting" || connection.status === "connecting" || isPending) {
    return (
      <button
        disabled
        className="rounded-full bg-raised px-4 py-2 text-sm font-medium text-ink-muted"
      >
        Connecting…
      </button>
    );
  }

  if (connection.status === "disconnected") {
    // Empty when no wallet is installed, in which case a connect button
    // would open nothing.
    const injected = connectors[0];
    if (!injected) {
      return (
        <a
          href="https://ethereum.org/en/wallets/find-wallet/"
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-border px-4 py-2 text-sm font-medium text-ink-muted hover:text-ink"
        >
          No wallet detected
        </a>
      );
    }
    return (
      <button
        onClick={() => connect({ connector: injected })}
        className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-ground transition hover:bg-accent-strong"
      >
        Connect wallet
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {sessionStatus === "anonymous" || sessionStatus === "error" ? (
        <button
          onClick={signIn}
          className="rounded-full border border-border px-3 py-2 text-sm text-ink-muted transition hover:text-ink"
        >
          Sign in
        </button>
      ) : sessionStatus === "signing" ? (
        <span className="px-3 py-2 text-sm text-ink-muted">Check your wallet…</span>
      ) : sessionStatus === "authenticated" ? (
        <button
          onClick={signOut}
          className="rounded-full border border-border px-3 py-2 text-sm text-ink-muted transition hover:text-ink"
        >
          Sign out
        </button>
      ) : null}

      <button
        onClick={() => disconnect()}
        title="Disconnect"
        className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-2 text-sm font-medium text-ink transition hover:border-border-strong"
      >
        <span className="size-2 rounded-full bg-positive" />
        <span className="tabular">{shortenAddress(connection.address)}</span>
      </button>
    </div>
  );
}
