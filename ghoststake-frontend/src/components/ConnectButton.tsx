"use client";

import { useEffect, useRef, useState } from "react";
import type { Connector } from "wagmi";
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

/**
 * Every wallet the browser announced, as something a person can choose from.
 *
 * EIP-6963 gives one connector per installed wallet. Taking `connectors[0]`
 * silently picks whichever announced first, so a machine with three wallets
 * can only ever reach one of them — and which one looks arbitrary, because it
 * is.
 *
 * The generic `injected` connector is dropped whenever a discovered wallet
 * exists: it targets whatever claimed `window.ethereum`, which is already one
 * of the entries below, so keeping it lists the same wallet twice under two
 * names.
 */
function useWallets(): Connector[] {
  const connectors = useConnectors();
  const discovered = connectors.filter((c) => c.id !== "injected");
  return discovered.length > 0 ? discovered : [...connectors];
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
    if (wallets.length === 0) {
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

    // One wallet needs no menu; a menu of one is a pointless extra click.
    if (wallets.length === 1) {
      return (
        <ConnectAction
          label="Connect wallet"
          onClick={() => connect({ connector: wallets[0] })}
          error={error}
        />
      );
    }

    return (
      <div className="relative" ref={menuRef}>
        <ConnectAction
          label="Connect wallet"
          onClick={() => setPicking((open) => !open)}
          error={error}
          expanded={picking}
        />
        {picking && (
          <div
            role="menu"
            className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-card border border-border bg-surface shadow-xl"
          >
            <p className="border-b border-border px-3 py-2 text-xs tracking-wide text-ink-faint uppercase">
              {wallets.length} wallets detected
            </p>
            {wallets.map((wallet) => (
              <button
                key={wallet.uid}
                role="menuitem"
                onClick={() => {
                  setPicking(false);
                  connect({ connector: wallet });
                }}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-ink transition hover:bg-raised"
              >
                <WalletIcon connector={wallet} />
                <span className="truncate">{wallet.name}</span>
              </button>
            ))}
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
