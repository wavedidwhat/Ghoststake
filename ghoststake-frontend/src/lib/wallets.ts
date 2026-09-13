/** The fields of a wagmi connector this module reads, so it can be tested without wagmi. */
export type WalletOption = {
  id: string;
  type: string;
  name: string;
};

/** EIP-6963 connectors take the wallet's reverse-DNS id; Coinbase Wallet announces this one. */
const COINBASE_RDNS = "com.coinbase.wallet";

/**
 * Every way this browser can connect, in the order a person should see them.
 *
 * Wallets the browser announced (EIP-6963) come first: they are already
 * installed, so they are one tap. Then the SDK connectors, which reach a wallet
 * that is not in this browser — the Coinbase app, or any mobile wallet through
 * WalletConnect. Those are the only way in from a phone's default browser.
 *
 * The generic `injected` connector targets whatever claimed `window.ethereum`.
 * When a wallet also announced itself it is the same wallet under a second
 * name, so it is dropped. With nothing announced it is kept only if a provider
 * actually exists: listing it on mobile Safari offers a button that can only
 * fail.
 *
 * The Coinbase SDK connector is dropped when the Coinbase extension announced
 * itself, for the same reason.
 */
export function orderWallets<T extends WalletOption>(
  connectors: readonly T[],
  hasInjectedProvider: boolean,
): { detected: T[]; other: T[] } {
  const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const generic = connectors.filter((c) => c.id === "injected");
  const sdk = connectors.filter((c) => c.type !== "injected");

  const detected =
    announced.length > 0 ? announced : hasInjectedProvider ? generic : [];

  const coinbaseAnnounced = announced.some((c) => c.id === COINBASE_RDNS);
  const other = sdk
    .filter((c) => !(coinbaseAnnounced && c.type === "coinbaseWallet"))
    .sort((a, b) => sdkRank(a) - sdkRank(b));

  return { detected, other };
}

/** Coinbase before WalletConnect: one named app, then the catch-all. */
function sdkRank(c: WalletOption): number {
  return c.type === "coinbaseWallet" ? 0 : c.type === "walletConnect" ? 1 : 2;
}
