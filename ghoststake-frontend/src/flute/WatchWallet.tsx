"use client";

import { useEffect, type ReactNode } from "react";
import { useConnect, useConnection } from "wagmi";
import { activeChain } from "@/lib/wagmi";

/**
 * A watch-only wallet for filming (Flute scenes only, development only).
 *
 * The connected screens (portfolio, borrow, loan health) need an address, and
 * every figure on them is read from the chain through wagmi's own RPC, never
 * through the wallet. So this provider answers exactly one question, "which
 * account?", and refuses everything that could sign or send. There is no key
 * anywhere: it can show a position, it cannot touch one.
 *
 * The default is the tester wallet (TESTER_KEY in .env.demo), which holds a
 * position built for filming: 5,000 deposited, 1,000 borrowed, and 60
 * borrowed to back Yes on demo round 393. Not the deployer: as the operator
 * it adds the Operator link to the sidebar.
 */
export const FILM_ADDRESS = "0x3fC461752ACBcE0a9034d71821489E6008F21Cb1";

type Eip1193 = { request(args: { method: string }): Promise<unknown>; on(): void; removeListener(): void };

function install(address: string) {
  const w = window as unknown as { ethereum?: Eip1193 & { isWatchOnly?: boolean } };
  if (w.ethereum?.isWatchOnly) return;
  const chainIdHex = `0x${activeChain.id.toString(16)}`;
  w.ethereum = {
    isWatchOnly: true,
    async request({ method }) {
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [address];
        case "eth_chainId":
          return chainIdHex;
        case "wallet_requestPermissions":
        case "wallet_revokePermissions":
          return [];
        default: {
          const err = new Error(`Watch-only wallet: ${method} refused.`) as Error & { code: number };
          err.code = 4200;
          throw err;
        }
      }
    },
    on() {},
    removeListener() {},
  };
}

/** `?film-address=0x…` on the scene URL swaps the filmed wallet without editing a scene. */
function addressFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = new URLSearchParams(window.location.search).get("film-address");
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? value : undefined;
}

export function WatchWallet({ address: given, children }: { address?: string; children: ReactNode }) {
  const address = given ?? addressFromUrl() ?? FILM_ADDRESS;
  const { connect, connectors } = useConnect();
  const connection = useConnection();

  useEffect(() => {
    if (connection.address?.toLowerCase() === address.toLowerCase()) return;
    install(address);
    const injected = connectors.find((c) => c.id === "injected");
    if (injected) connect({ connector: injected, chainId: activeChain.id });
  }, [address, connect, connectors, connection.address]);

  // FreezeForCapture holds export while this marker is present, so a scene
  // never films "Connect a wallet" because the connection was still settling
  // (or never came).
  const connected = connection.address?.toLowerCase() === address.toLowerCase();
  return (
    <>
      {!connected && <span data-film-pending hidden />}
      {children}
    </>
  );
}
