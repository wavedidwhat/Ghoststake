// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { BorrowToPositionRouter } from "../src/BorrowToPositionRouter.sol";
import { MarketRegistry } from "../src/MarketRegistry.sol";
import { ParimutuelRound } from "../src/ParimutuelRound.sol";

/// @notice Adds a `MarketRegistry` to a deployment that already exists, and
/// lists the markets already running on it.
///
///     MARKET_ADDRESS=0x… ROUTER_ADDRESS=0x… \
///       forge script script/DeployRegistry.s.sol:DeployRegistry \
///       --rpc-url "$RPC_URL" --broadcast --slow
///
/// # Why this is separate from `Deploy`
///
/// `Deploy` creates a registry, but it also creates a pool and a vault — and
/// the vault takes its lien source as a constructor immutable, so running it
/// again strands every position on the old contracts. The Sepolia deployment
/// predates the registry entirely, and this is the path that does not cost it
/// anything: one new contract, and a listing transaction per market.
///
/// # Listing is a claim the registry checks
///
/// Every market named here goes through `MarketRegistry.list`, which refuses
/// a router bound to a different market or one the market has not
/// whitelisted. So a typo in `ROUTER_ADDRESS` fails here, on the deployer's
/// transaction, rather than later on a user's.
contract DeployRegistry is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        ParimutuelRound market = ParimutuelRound(vm.envAddress("MARKET_ADDRESS"));
        BorrowToPositionRouter router = BorrowToPositionRouter(vm.envAddress("ROUTER_ADDRESS"));

        // Optional, and normal to omit: a deployment may have no demo market.
        address demoMarket = vm.envOr("DEMO_MARKET_ADDRESS", address(0));
        address demoRouter = vm.envOr("DEMO_ROUTER_ADDRESS", address(0));

        vm.startBroadcast(deployerKey);

        MarketRegistry registry = new MarketRegistry(deployer);
        registry.list(market, router, uint64(vm.envOr("MARKET_HORIZON", uint256(1 hours))));

        if (demoMarket != address(0) && demoRouter != address(0)) {
            registry.list(
                ParimutuelRound(demoMarket),
                BorrowToPositionRouter(demoRouter),
                uint64(vm.envOr("DEMO_HORIZON", uint256(5 minutes)))
            );
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== deployed ===");
        console2.log("MarketRegistry      ", address(registry));
        console2.log("listed markets      ", registry.count());
        console2.log("owner               ", deployer);
        console2.log("");
        console2.log("--- frontend .env.local ---");
        console2.log("NEXT_PUBLIC_REGISTRY_ADDRESS=%s", vm.toString(address(registry)));
    }
}
