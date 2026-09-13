"use client";

import { useEffect, useRef, useState } from "react";
import type { Connector } from "wagmi";
import { useConnection, useConnect, useConnectors, useDisconnect } from "wagmi";
import { shortenAddress } from "@/lib/format";
import { orderWallets } from "@/lib/wallets";
import { useSession } from "@/hooks/useSession";

/**
 * Connect, disconnect, and the optional SIWE sign-in.
 *
 * wagmi 3 has no `useAccount`: connection state is `useConnection`, and
 * `useConnect().connect` / `.connectors` are deprecated in favour of
 * `mutate` and `useConnectors`.
 */

/**
 * Every way to connect, as something a person can choose from.
 *
 * EIP-6963 gives one connector per installed wallet. Taking `connectors[0]`
 * silently picks whichever announced first, so a machine with three wallets
 * can only ever reach one of them — and which one looks arbitrary, because it
 * is. The ordering and de-duplication rules live in `orderWallets`.
 */
function useWallets() {
  const connectors = useConnectors();
  const hasInjectedProvider =
    typeof window !== "undefined" && "ethereum" in window && window.ethereum !== undefined;
  return orderWallets(connectors, hasInjectedProvider);
}

export function ConnectButton() {
  const connection = useConnection();
  const wallets = useWallets();
  const { mutate: connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { status: sessionStatus, signIn, signOut } = useSession();

  const [picking, setPicking] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape, the two ways anyone expects to
  // dismiss a menu they opened by accident.
  useEffect(() => {
    if (!picking) return;
    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setPicking(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setPicking(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [picking]);

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
    const all = [...wallets.detected, ...wallets.other];

    const pick = (wallet: Connector) => {
      setPicking(false);
      connect({ connector: wallet });
    };

    // The markup must not depend on how many options there are. The server
    // has no WalletConnect connector (see wagmi.ts) and so counts one fewer
    // than the browser; branching the element on the count was a hydration
    // mismatch (React #418). The count decides what a click does instead —
    // one option connects directly, since a menu of one is a pointless click.
    return (
      <div className="relative" ref={menuRef}>
        <ConnectAction
          label="Connect wallet"
          onClick={() => (all.length === 1 ? pick(all[0]) : setPicking((open) => !open))}
          error={error}
          expanded={picking}
        />
        {picking && (
          <div
            role="menu"
            className="absolute right-0 z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-card border border-border bg-surface shadow-xl"
          >
            {wallets.detected.length > 0 && (
              <WalletGroup label="In this browser" wallets={wallets.detected} onPick={pick} />
            )}
            {wallets.other.length > 0 && (
              <WalletGroup
                // Said plainly, because on a phone this group is the only way
                // in and "WalletConnect" alone means nothing to most people.
                label={wallets.detected.length > 0 ? "Other wallets" : "Connect a mobile wallet"}
                wallets={wallets.other}
                onPick={pick}
              />
            )}
          </div>
        )}
      </div>
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

function ConnectAction({
  label,
  onClick,
  error,
  expanded,
}: {
  label: string;
  onClick: () => void;
  error: Error | null;
  expanded?: boolean;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={onClick}
        aria-haspopup={expanded === undefined ? undefined : "menu"}
        aria-expanded={expanded}
        className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-ground transition hover:bg-accent-strong"
      >
        {label}
      </button>
      {/* A dismissed wallet prompt is a normal outcome and says so quietly,
          rather than reading as a failure. */}
      {error && (
        <span className="text-xs text-ink-faint">
          {/rejected|denied|User rejected/i.test(error.message)
            ? "Cancelled"
            : "Could not connect"}
        </span>
      )}
    </div>
  );
}

function WalletGroup({
  label,
  wallets,
  onPick,
}: {
  label: string;
  wallets: Connector[];
  onPick: (wallet: Connector) => void;
}) {
  return (
    <div className="border-b border-border last:border-b-0">
      <p className="px-3 pt-2 pb-1 text-xs tracking-wide text-ink-faint uppercase">{label}</p>
      {wallets.map((wallet) => (
        <button
          key={wallet.uid}
          role="menuitem"
          onClick={() => onPick(wallet)}
          className="flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-ink transition hover:bg-raised"
        >
          <WalletIcon connector={wallet} />
          <span className="truncate">{wallet.name}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * EIP-6963 wallets announce their own icon as a data URI. Falls back to the
 * first letter rather than a broken image for anything that does not.
 */
function WalletIcon({ connector }: { connector: Connector }) {
  if (connector.icon) {
    // A data: URI the wallet supplies itself. next/image cannot optimise one
    // and would only add a round trip, so a plain img is correct here.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={connector.icon} alt="" className="size-5 shrink-0 rounded" />
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded bg-raised text-[10px] font-medium text-ink-muted">
      {connector.name.charAt(0)}
    </span>
  );
}
