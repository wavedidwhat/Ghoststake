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
export type ContractId = "vault" | "pool" | "registry" | "router" | "market" | "demoMarket" | "stockVault";

/** Its name and what it does are `contracts.<id>.name` / `.role` in the catalog (GHO-120). */
export type DeployedContract = { id: ContractId; address: `0x${string}` };

export function deployedContracts(): DeployedContract[] {
  const list: (DeployedContract | undefined)[] = [
    env.vaultAddress && {
      id: "vault",
      address: env.vaultAddress,
    },
    env.poolAddress && {
      id: "pool",
      address: env.poolAddress,
    },
    env.registryAddress && {
      id: "registry",
      address: env.registryAddress,
    },
    env.routerAddress && {
      id: "router",
      address: env.routerAddress,
    },
    env.marketAddress && {
      id: "market",
      address: env.marketAddress,
    },
    env.demoMarketAddress && {
      id: "demoMarket",
      address: env.demoMarketAddress,
    },
    env.stockVaultAddress && {
      id: "stockVault",
      address: env.stockVaultAddress,
    },
  ];
  return list.filter((c): c is DeployedContract => Boolean(c));
}
