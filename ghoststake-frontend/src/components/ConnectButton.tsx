"use client";

import { useEffect, useRef, useState } from "react";
import type { Connector } from "wagmi";
import { useConnect, useConnectors, useDisconnect } from "wagmi";
import { shortenAddress } from "@/lib/format";
import { orderWallets } from "@/lib/wallets";
import { useSession, type SessionStatus } from "@/hooks/useSession";
import { useStalled } from "@/hooks/useStalled";
import { useWallet } from "@/hooks/useWallet";

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

/** A dismissed wallet prompt is a normal outcome, and says so quietly. */
function connectHint(error: Error | null): string | undefined {
  if (!error) return undefined;
  return /rejected|denied|User rejected/i.test(error.message) ? "Cancelled" : "Could not connect";
}

export function ConnectButton() {
  const { address, isSettling } = useWallet();
  const wallets = useWallets();
  const { mutate: connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const {
    status: sessionStatus,
    error: sessionError,
    attempt: sessionAttempt,
    signIn,
    signOut,
    stopWaiting,
  } = useSession();

  const [picking, setPicking] = useState(false);
  const [attempt, setAttempt] = useState(0);
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

  /**
   * "Connecting…" means we do not know whose wallet this is yet — not that
   * wagmi is still checking.
   *
   * The difference matters on a reload. wagmi restores the previous address
   * from storage immediately and only then re-checks it with the wallet, so
   * branching on the status showed "Connecting…" over a page that was already
   * rendering that address's balances (GHO-77). With an address in hand there
   * is something true to show, so we show it. Without one there is nothing to
   * say but "connecting", and `useStalled` bounds how long we say it.
   */
  const settling = !address && (isSettling || isPending);
  const stalled = useStalled(settling, attempt);

  if (settling && !stalled) {
    return (
      <button
        disabled
        className="rounded-sm bg-raised px-4 py-2 text-sm font-medium text-ink-muted"
      >
        Connecting…
      </button>
    );
  }

  // No address: nobody is connected, or an attempt has been quiet for too long
  // and a stalled wallet gets the ordinary connect affordance back rather than a
  // disabled button and a reload.
  if (!address) {
    const all = [...wallets.detected, ...wallets.other];

    const pick = (wallet: Connector) => {
      setPicking(false);
      // Restarts the stall timer, so this attempt shows "Connecting…" on its own
      // terms instead of inheriting the previous one's verdict.
      setAttempt((n) => n + 1);
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
          // The stall outranks a stored error: it is the more recent news, and
          // the attempt it describes may still be sitting there unanswered.
          hint={stalled ? "Your wallet didn't respond" : connectHint(error)}
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
      <SessionAction
        status={sessionStatus}
        error={sessionError}
        attempt={sessionAttempt}
        onSignIn={signIn}
        onSignOut={signOut}
        onStopWaiting={stopWaiting}
      />

      <button
        onClick={() => disconnect()}
        title="Disconnect"
        className="flex items-center gap-2 rounded-sm border border-border bg-surface px-3 py-2 text-sm font-medium text-ink transition hover:border-border-strong"
      >
        <span className="size-2 rounded-full bg-positive" />
        <span className="tabular">{shortenAddress(address)}</span>
      </button>
    </div>
  );
}

/**
 * The SIWE half of the button.
 *
 * A failed sign-in used to render the same bare "Sign in" as never having
 * signed in at all: `useSession` computed the reason and the caller dropped it
 * on the floor (GHO-77). Someone whose sign-in failed clicked, saw nothing
 * change, and had nothing to act on. The reason is shown instead.
 *
 * And "Check your wallet…" used to be a `<span>` — not a control, with no
 * timeout behind it (GHO-83). A wallet that took the request and never
 * answered pinned it there until a reload, which is exactly the state GHO-77
 * removed from the connect half and left in this one.
 */
function SessionAction({
  status,
  error,
  attempt,
  onSignIn,
  onSignOut,
  onStopWaiting,
}: {
  status: SessionStatus;
  error: string | null;
  attempt: number;
  onSignIn: () => void;
  onSignOut: () => void;
  onStopWaiting: () => void;
}) {
  const waiting = status === "signing";
  const stalled = useStalled(waiting, attempt);

  if (waiting) {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="px-3 py-2 text-sm text-ink-muted">Check your wallet…</span>
        {/* Only once it has actually gone quiet. Offering an out immediately
            would read as "this probably will not work" on every sign-in. */}
        {stalled && (
          <button
            onClick={onStopWaiting}
            className="px-3 text-xs text-ink-faint underline-offset-2 transition-colors hover:text-ink hover:underline"
          >
            Your wallet hasn&rsquo;t answered — stop waiting
          </button>
        )}
      </div>
    );
  }

  if (status === "authenticated") {
    return (
      <button
        onClick={onSignOut}
        className="rounded-sm border border-border px-3 py-2 text-sm text-ink-muted transition hover:text-ink"
      >
        Sign out
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={onSignIn}
        className="rounded-sm border border-border px-3 py-2 text-sm text-ink-muted transition hover:text-ink"
      >
        Sign in
      </button>
      {/* Louder than the connect hints: a signature that failed for a reason the
          API gave is not something clicking again reliably fixes. */}
      {status === "error" && error && (
        <span className="max-w-48 text-right text-xs text-negative">{error}</span>
      )}
    </div>
  );
}

function ConnectAction({
  label,
  onClick,
  hint,
  expanded,
}: {
  label: string;
  onClick: () => void;
  hint?: string;
  expanded?: boolean;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={onClick}
        aria-haspopup={expanded === undefined ? undefined : "menu"}
        aria-expanded={expanded}
        className="rounded-sm bg-action px-4 py-2 text-sm font-medium text-ground transition hover:bg-action-strong"
      >
        {label}
      </button>
      {/* Quiet rather than alarming: every reason this appears — a dismissed
          prompt, a wallet that went quiet — is recoverable by clicking again. */}
      {hint && <span className="text-xs text-ink-faint">{hint}</span>}
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
