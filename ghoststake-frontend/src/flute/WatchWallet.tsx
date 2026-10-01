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
 * The default is the deployer, which holds the one open loan on testnet.
 */
export const FILM_ADDRESS = "0xE64b1081681c475A0Ec61b3B3f90e82734049275";

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

  return <>{children}</>;
}
