import { describe, expect, it } from "vitest";
import { orderWallets, type WalletOption } from "../wallets";

const generic: WalletOption = { id: "injected", type: "injected", name: "Injected" };
const metamask: WalletOption = { id: "io.metamask", type: "injected", name: "MetaMask" };
const rabby: WalletOption = { id: "io.rabby", type: "injected", name: "Rabby" };
const coinbaseExt: WalletOption = { id: "com.coinbase.wallet", type: "injected", name: "Coinbase Wallet" };
const coinbaseSdk: WalletOption = { id: "coinbaseWalletSDK", type: "coinbaseWallet", name: "Coinbase Wallet" };
const walletConnect: WalletOption = { id: "walletConnect", type: "walletConnect", name: "WalletConnect" };

const ids = (list: WalletOption[]) => list.map((c) => c.id);

describe("orderWallets", () => {
  it("offers only the SDK connectors on a phone browser with no wallet", () => {
    // Mobile Safari: no extension, no window.ethereum. The generic injected
    // connector would be a button that can only fail.
    const { detected, other } = orderWallets([generic, coinbaseSdk, walletConnect], false);
    expect(ids(detected)).toEqual([]);
    expect(ids(other)).toEqual(["coinbaseWalletSDK", "walletConnect"]);
  });

  it("lists announced wallets and drops the generic duplicate", () => {
    const { detected } = orderWallets([generic, metamask, rabby, walletConnect], true);
    expect(ids(detected)).toEqual(["io.metamask", "io.rabby"]);
  });

  it("keeps the generic connector when a provider exists but nothing announced", () => {
    // An older wallet, or an in-app browser that injects without EIP-6963.
    const { detected } = orderWallets([generic, coinbaseSdk], true);
    expect(ids(detected)).toEqual(["injected"]);
  });

  it("hides the Coinbase SDK when the Coinbase extension announced itself", () => {
    const { detected, other } = orderWallets([coinbaseExt, coinbaseSdk, walletConnect], true);
    expect(ids(detected)).toEqual(["com.coinbase.wallet"]);
    expect(ids(other)).toEqual(["walletConnect"]);
  });

  it("puts Coinbase before WalletConnect regardless of config order", () => {
    const { other } = orderWallets([walletConnect, coinbaseSdk], false);
    expect(ids(other)).toEqual(["coinbaseWalletSDK", "walletConnect"]);
  });
});
