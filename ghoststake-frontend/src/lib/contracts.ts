import { env } from "./env";

/**
 * Every contract this deployment of the app talks to, with what it does in
 * words a user would use (GHO-103).
 *
 * The list the How it works page shows under "Check it yourself". Built from
 * the configured addresses rather than typed out, so it can't name a
 * contract the app doesn't actually use, or miss one it does. Markets listed
 * in the on-chain registry are read live by the page and added to these.
 */
export type DeployedContract = { name: string; role: string; address: `0x${string}` };

export function deployedContracts(): DeployedContract[] {
  const list: (DeployedContract | undefined)[] = [
    env.vaultAddress && {
      name: "Collateral vault",
      role: "Holds your stake, pays its yield, and records what is borrowed against it.",
      address: env.vaultAddress,
    },
    env.poolAddress && {
      name: "Lending pool",
      role: "Lenders' money. Borrowing draws from it, and interest goes back to it.",
      address: env.poolAddress,
    },
    env.registryAddress && {
      name: "Market registry",
      role: "The list of markets. Adding or delisting one is a transaction here.",
      address: env.registryAddress,
    },
    env.routerAddress && {
      name: "Router",
      role: "Borrows against your stake and takes a side in one transaction.",
      address: env.routerAddress,
    },
    env.marketAddress && {
      name: "Market",
      role: "Holds the pools for each round and pays out when it settles.",
      address: env.marketAddress,
    },
    env.demoMarketAddress && {
      name: "Demo market",
      role: "A market on an operator-set price, for trying things out.",
      address: env.demoMarketAddress,
    },
    env.stockVaultAddress && {
      name: "Stock-loan vault",
      role: "Holds tokenized shares you borrow against, and the loans on them.",
      address: env.stockVaultAddress,
    },
  ];
  return list.filter((c): c is DeployedContract => Boolean(c));
}
