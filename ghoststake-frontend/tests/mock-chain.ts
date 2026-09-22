import type { Page, Route } from "@playwright/test";
import {
  type Abi,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  maxUint256,
  numberToHex,
} from "viem";
import {
  aggregatorV3InterfaceAbi,
  borrowLiquidityPoolAbi,
  borrowToPositionRouterAbi,
  chainlinkRoundOracleAbi,
  collateralVaultAbi,
  mockUSDCAbi,
  parimutuelRoundAbi,
} from "../src/lib/abis";

/**
 * A chain the browser tests can see (GHO-87).
 *
 * The other half of `mock-wallet.ts`. The wallet decides how signing behaves;
 * this decides what the contracts say. Together they let a test put a market
 * on screen, open the position sheet and press the button, which no test in
 * this repo had ever done — CI has no chain, so every page rendered its "not
 * deployed here" state and nothing past it was reachable.
 *
 * It intercepts the one RPC URL the e2e build is pointed at (`tests/e2e.env`)
 * and answers `eth_call` by decoding the calldata against the app's **own
 * ABIs** and encoding a result from a table. Using the same ABIs the app reads
 * with means a fixture answer cannot drift from what the app expects without
 * failing to encode. A function nobody put in the table reverts, the way a
 * contract without it would — which is exactly the failure the app has to
 * survive, so the default is a useful test by itself.
 *
 * Usage: every spec gets it from `tests/fixtures.ts`. To change what a
 * contract says for one test, `chain.set(address, fn, value)` before `goto`,
 * or `chain.revert(address, fn)` to make a read fail.
 */

/** The addresses the e2e build is compiled with. Must match `tests/e2e.env`. */
export const E2E = {
  rpcUrl: "https://rpc.e2e.ghoststake.test",
  chainId: 31337,
  vault: "0x00000000000000000000000000000000000e2e01",
  pool: "0x00000000000000000000000000000000000e2e02",
  market: "0x00000000000000000000000000000000000e2e03",
  router: "0x00000000000000000000000000000000000e2e04",
  asset: "0x00000000000000000000000000000000000e2e05",
  oracle: "0x00000000000000000000000000000000000e2e06",
  feed: "0x00000000000000000000000000000000000e2e07",
} as const;

/** 6 decimals, like the real mUSDC: the scale GHO-86 got wrong. */
export const DECIMALS = 6;
const unit = (n: number) => BigInt(Math.round(n * 1e6));
const WAD = 10n ** 18n;

type Answer = unknown | ((args: readonly unknown[]) => unknown);
type Table = Map<string, Map<string, Answer | typeof REVERT>>;

const REVERT = Symbol("revert");

const ABIS: Record<string, Abi> = {
  [E2E.vault]: collateralVaultAbi as Abi,
  [E2E.pool]: borrowLiquidityPoolAbi as Abi,
  [E2E.market]: parimutuelRoundAbi as Abi,
  [E2E.router]: borrowToPositionRouterAbi as Abi,
  // The asset answers as ERC-20 and as the mintable mock, like MockUSDC does.
  // Deduplicated by name: both declare balanceOf, decimals and the rest, and
  // two identical entries make an encode ambiguous.
  [E2E.asset]: [
    ...erc20Abi,
    ...(mockUSDCAbi as Abi).filter(
      (item) => item.type !== "function" || !erc20Abi.some((e) => e.type === "function" && e.name === item.name),
    ),
  ] as Abi,
  [E2E.oracle]: chainlinkRoundOracleAbi as Abi,
  [E2E.feed]: aggregatorV3InterfaceAbi as Abi,
};

/**
 * One market with one round open for entry, a wallet holding 5,000 mUSDC and
 * 1,000 staked with nothing borrowed. Times are relative to when the page
 * reads them, so the round stays open for the length of a test.
 */
function defaults(): Table {
  const now = () => BigInt(Math.floor(Date.now() / 1000));
  const t: Table = new Map();
  const set = (address: string, entries: Record<string, Answer>) =>
    t.set(address, new Map(Object.entries(entries)));

  set(E2E.vault, {
    asset: E2E.asset,
    collateralValue: unit(1000),
    accruedYield: 0n,
    totalLedgerValue: unit(1000),
    lienOf: 0n,
    healthFactor: maxUint256,
    maxBorrowable: unit(600),
    isLiquidatable: false,
    balanceOf: unit(1000),
    liquidationThreshold: (8n * WAD) / 10n,
    yieldRatePerSecond: 0n,
    borrowAllowance: 0n,
  });
  set(E2E.asset, {
    decimals: DECIMALS,
    symbol: "mUSDC",
    balanceOf: unit(5000),
    allowance: 0n,
    mint: undefined,
  });
  set(E2E.market, {
    entryCutoff: 15n,
    minSidePool: unit(1),
    rake: (2n * WAD) / 100n,
    lockWindow: 3600n,
    resolveDeadline: 3600n,
    owner: "0x0000000000000000000000000000000000000bad",
    oracle: E2E.oracle,
    roundCount: 1n,
    rounds: () => ({
      openTime: now() - 60n,
      lockTime: now() + 600n,
      closeTime: now() + 1200n,
      status: 1, // Open
      winner: 0,
      lockPrice: 0n,
      closePrice: 0n,
      lockOracleRoundId: 0n,
      upPool: unit(300),
      downPool: unit(200),
      rakeTaken: 0n,
    }),
    phaseOf: 1, // Open
    stakeOf: 0n,
    claimableOf: 0n,
    claimed: false,
  });
  set(E2E.oracle, { feed: E2E.feed });
  set(E2E.feed, { description: "ETH / USD" });
  return t;
}

export class MockChain {
  private table = defaults();
  /** Every eth_call the page made, as "address.function", for assertions. */
  readonly calls: string[] = [];

  /** What `fn` on `address` returns from now on. */
  set(address: string, fn: string, value: Answer) {
    this.contract(address).set(fn, value);
  }

  /** Make `fn` on `address` revert, as a read that cannot be served. */
  revert(address: string, fn: string) {
    this.contract(address).set(fn, REVERT);
  }

  /**
   * Leave every request that reads `fn` on `address` unanswered, so a test
   * can look at the page in the window before a read resolves — the window
   * GHO-86's wrong-scale figures lived in, which a fast mock otherwise
   * closes before anything can observe it.
   */
  hold(address: string, fn: string) {
    this.held.add(`${address.toLowerCase()}.${fn}`);
  }

  private held = new Set<string>();

  private contract(address: string) {
    const key = address.toLowerCase();
    let c = this.table.get(key);
    if (!c) this.table.set(key, (c = new Map()));
    return c;
  }

  async install(page: Page) {
    await page.route(`${E2E.rpcUrl}/**`, (route) => this.handle(route));
    await page.route(E2E.rpcUrl, (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const body = route.request().postDataJSON() as RpcRequest | RpcRequest[];
    const requests = Array.isArray(body) ? body : [body];
    if (requests.some((r) => this.isHeld(r))) return; // never fulfilled
    const reply = Array.isArray(body) ? body.map((r) => this.answer(r)) : this.answer(body);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(reply) });
  }

  private isHeld(req: RpcRequest): boolean {
    if (req.method !== "eth_call" || this.held.size === 0) return false;
    const { to, data } = (req.params?.[0] ?? {}) as { to?: string; data?: `0x${string}` };
    const address = (to ?? "").toLowerCase();
    const abi = ABIS[address];
    if (!abi || !data) return false;
    try {
      return this.held.has(`${address}.${decodeFunctionData({ abi, data }).functionName}`);
    } catch {
      return false;
    }
  }

  private answer(req: RpcRequest) {
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    const now = Math.floor(Date.now() / 1000);
    switch (req.method) {
      case "eth_chainId":
        return ok(numberToHex(E2E.chainId));
      case "eth_blockNumber":
        return ok(numberToHex(1000));
      case "eth_getBlockByNumber":
        return ok({ number: numberToHex(1000), timestamp: numberToHex(now), hash: `0x${"11".repeat(32)}` });
      case "eth_call":
        return this.call(req);
      default:
        return ok(null);
    }
  }

  private call(req: RpcRequest) {
    const { to, data } = (req.params?.[0] ?? {}) as { to?: string; data?: `0x${string}` };
    const address = (to ?? "").toLowerCase();
    const revert = (why: string) => ({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: 3, message: `execution reverted: ${why}`, data: "0x" },
    });

    const abi = ABIS[address];
    if (!abi || !data) return revert(`no contract at ${address}`);

    let decoded: { functionName: string; args?: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi, data });
    } catch {
      return revert("unknown selector");
    }
    const fn = decoded.functionName;
    this.calls.push(`${address}.${fn}`);

    const answer = this.table.get(address)?.get(fn);
    if (answer === REVERT || (answer === undefined && !this.table.get(address)?.has(fn))) {
      return revert(`${fn} not in the mock table`);
    }
    const value = typeof answer === "function" ? (answer as (a: readonly unknown[]) => unknown)(decoded.args ?? []) : answer;
    const result = encodeFunctionResult({
      abi,
      functionName: fn,
      // A function with no outputs (a simulated write) encodes to 0x.
      result: value as never,
    });
    return { jsonrpc: "2.0", id: req.id, result };
  }
}

type RpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown[] };
