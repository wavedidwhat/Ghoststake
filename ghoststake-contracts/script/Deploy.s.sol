// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";
import { CollateralVault, ILienSource } from "../src/CollateralVault.sol";
import { ChainlinkRoundOracle } from "../src/ChainlinkRoundOracle.sol";
import { ParimutuelRound } from "../src/ParimutuelRound.sol";
import { BorrowToPositionRouter } from "../src/BorrowToPositionRouter.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";
import { DemoPriceFeed } from "../src/demo/DemoPriceFeed.sol";
import { MarketRegistry } from "../src/MarketRegistry.sol";
import { MarketDeployer } from "./MarketDeployer.sol";

/// @notice Deploys the whole stack to a local chain.
///
/// Run with `make deploy-local` from the repo root, which starts anvil first.
///
/// `MockUSDC` is the only thing here that changes for a real network: on a
/// testnet the asset is a real ERC-20 and the aggregator is a real Chainlink
/// feed address. Everything else — the parameters, the ordering, the
/// cross-wiring — is what a testnet deploy runs too, which is the point of
/// proving it locally first.
///
/// # Two markets, where the network has a real feed
///
/// GHO-29: a round cannot resolve until its feed publishes *after* the close,
/// and a real feed's heartbeat is tens of minutes. So where `FEED_ADDRESS`
/// names a real Chainlink feed, a second market is deployed alongside it on a
/// `DemoPriceFeed` the deployer publishes into by hand. Same contract, same
/// adapter, same settlement path — only the publisher differs. The real-feed
/// market stays the headline; the demo one exists so a round can be shown
/// resolving inside a few minutes.
///
/// Locally there is no real feed to be slow, so the primary market already
/// runs on a `DemoPriceFeed` of its own and the second one is off by default.
/// `scripts/local-stack.sh` turns it on anyway with `DEMO_MARKET=true`, so
/// what is developed against has the same two markets the demo does.
contract Deploy is MarketDeployer {
    // A year in seconds, for turning APRs into the per-second WAD rates these
    // contracts take. Writing `5% APR` in the config and converting here
    // beats committing a bare 1585489599 that nobody can sanity-check.
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant WAD = 1e18;

    MarketRegistry internal registry;

    // `demoFeed`, `demoMarket` and `demoRouter` are inherited from
    // MarketDeployer, and are storage rather than locals because `run`
    // deploys eleven contracts and the stack will not hold them all.

    function run() external {
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey == 0) {
            // anvil's first prefunded account. Only ever correct locally, and
            // stated out loud rather than hidden in a default.
            deployerKey = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
            console2.log("PRIVATE_KEY unset: using anvil account 0");
        }
        address deployer = vm.addr(deployerKey);

        // Each of these may be supplied for a real network. Unset means
        // "deploy a stand-in", which is only ever right on a disposable chain.
        address existingAsset = vm.envOr("ASSET_ADDRESS", address(0));
        address existingFeed = vm.envOr("FEED_ADDRESS", address(0));
        address sequencerFeed = vm.envOr("SEQUENCER_FEED_ADDRESS", address(0));

        vm.startBroadcast(deployerKey);

        // A mintable stand-in locally; a real ERC-20 anywhere else. Six
        // decimals either way — see MockUSDC for why that matters.
        IERC20 asset = existingAsset == address(0) ? IERC20(address(new MockUSDC())) : IERC20(existingAsset);

        // --- Lending ------------------------------------------------------
        //
        // Order is forced: the vault takes its lien source as a constructor
        // immutable, so the pool must exist first. The pool then needs to be
        // told which contract may borrow on users' behalf, and that setter is
        // one-shot — see BorrowModuleAlreadySet.
        BorrowLiquidityPool pool = new BorrowLiquidityPool(
            asset,
            perSecond(2), // base rate, 2% APR at zero utilization
            perSecond(8), // slope 1, gentle up to the kink
            perSecond(100), // slope 2, punishing past it
            0.8e18, // kink at 80% utilization
            0.1e18, // 10% of borrower interest to reserves
            deployer
        );

        CollateralVault vault = new CollateralVault(
            asset,
            perSecond(5), // 5% APR staking yield
            ILienSource(address(pool)),
            CollateralVault.RiskParams({
                maxLTV: 0.6e18, // borrow up to 60% of collateral
                liquidationThreshold: 0.8e18, // liquidatable past 80%
                liquidationBonus: 0.05e18, // 5% discount to liquidators
                closeFactor: 0.5e18 // at most half a lien per liquidation
             })
        );

        pool.setBorrowModule(address(vault));

        // --- Market -------------------------------------------------------
        //
        // A real Chainlink feed where one is given. Otherwise an operator-
        // driven `DemoPriceFeed`, seeded with a round so the adapter has
        // something to read — an empty feed reads as unavailable, which is
        // correct but leaves the first round un-lockable.
        address feed = existingFeed;
        if (feed == address(0)) {
            DemoPriceFeed localFeed = new DemoPriceFeed(8, "ETH / USD", deployer);
            localFeed.push(2000e8);
            feed = address(localFeed);
        }

        (ChainlinkRoundOracle oracle, ParimutuelRound market, BorrowToPositionRouter router) =
            deployMarket(asset, vault, feed, sequencerFeed, deployer);

        // The list of markets the app offers, on chain rather than in the
        // frontend's build args (GHO-34). Listing happens here because the
        // registry refuses a market whose router is not wired up, and this is
        // where the wiring is done.
        registry = new MarketRegistry(deployer);
        registry.list(market, router, uint64(vm.envOr("MARKET_HORIZON", uint256(1 hours))));

        // The demo market, on a feed this deployer can publish into on cue.
        // Only worth deploying where the primary feed is a real one that
        // cannot be hurried: locally the primary feed is already controllable.
        if (vm.envOr("DEMO_MARKET", existingFeed != address(0))) {
            deployDemoMarket(asset, vault, sequencerFeed, deployer);
            listIfPossible(
                address(registry),
                ParimutuelRound(demoMarket),
                BorrowToPositionRouter(demoRouter),
                uint64(vm.envOr("DEMO_HORIZON", uint256(5 minutes)))
            );
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== deployed ===");
        console2.log("Asset               ", address(asset));
        console2.log("BorrowLiquidityPool ", address(pool));
        console2.log("CollateralVault     ", address(vault));
        console2.log("PriceFeed           ", feed);
        console2.log("ChainlinkRoundOracle", address(oracle));
        console2.log("ParimutuelRound     ", address(market));
        console2.log("BorrowToPositionRtr ", address(router));
        console2.log("MarketRegistry      ", address(registry));
        if (demoMarket != address(0)) {
            console2.log("DemoPriceFeed       ", demoFeed);
            console2.log("DemoParimutuelRound ", demoMarket);
            console2.log("DemoBorrowToPosRtr  ", demoRouter);
        }
        console2.log("deployer            ", deployer);
        console2.log("");
        console2.log("--- frontend .env.local ---");
        console2.log("NEXT_PUBLIC_VAULT_ADDRESS=%s", vm.toString(address(vault)));
        console2.log("NEXT_PUBLIC_POOL_ADDRESS=%s", vm.toString(address(pool)));
        console2.log("NEXT_PUBLIC_MARKET_ADDRESS=%s", vm.toString(address(market)));
        console2.log("NEXT_PUBLIC_ROUTER_ADDRESS=%s", vm.toString(address(router)));
        console2.log("NEXT_PUBLIC_REGISTRY_ADDRESS=%s", vm.toString(address(registry)));
        if (demoMarket != address(0)) {
            console2.log("NEXT_PUBLIC_DEMO_MARKET_ADDRESS=%s", vm.toString(demoMarket));
            console2.log("NEXT_PUBLIC_DEMO_ROUTER_ADDRESS=%s", vm.toString(demoRouter));
        }
        console2.log("");
        console2.log("--- backend .env ---");
        console2.log("VAULT_ADDRESS=%s", vm.toString(address(vault)));
        console2.log("POOL_ADDRESS=%s", vm.toString(address(pool)));
        console2.log("MARKET_ADDRESS=%s", vm.toString(address(market)));
        console2.log("INDEXER_START_BLOCK=%s", vm.toString(block.number));
        console2.log("INDEXER_ENABLED=true");
    }

    /// @dev An APR in whole percent to the per-second WAD rate the contracts
    /// take. Simple, not compounded, matching how the contracts accrue.
    function perSecond(uint256 aprPercent) internal pure returns (uint256) {
        return (aprPercent * WAD) / 100 / YEAR;
    }
}
