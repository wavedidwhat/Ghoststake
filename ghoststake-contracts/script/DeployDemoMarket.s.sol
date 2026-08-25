// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { CollateralVault } from "../src/CollateralVault.sol";
import { MarketDeployer } from "./MarketDeployer.sol";

/// @notice Adds the demo market (GHO-29) to a deployment that already exists.
///
///     VAULT_ADDRESS=0x… forge script script/DeployDemoMarket.s.sol:DeployDemoMarket \
///       --rpc-url "$RPC_URL" --broadcast --slow
///
/// # Why this is not just re-running `Deploy`
///
/// `Deploy` builds the whole stack, and the vault takes its lien source as a
/// constructor immutable — so a fresh run means a fresh pool and a fresh
/// vault, and every position anyone holds is left behind on contracts nothing
/// points at any more. The indexer notices too: its cursor fingerprint covers
/// the addresses it was started on and refuses to resume against different
/// ones, which is correct and is a redeploy's problem to solve, not a demo
/// market's.
///
/// A market needs none of that. It needs the asset and the vault, both of
/// which already exist, so this deploys the four contracts that are actually
/// new — feed, adapter, round, router — and leaves everything else alone.
///
/// # The asset is read from the vault, not passed in
///
/// A market whose stake asset differs from the vault's would take deposits
/// nobody could borrow into, and the mistake would only surface at the first
/// `openPosition`. The vault already knows the answer, so it is asked.
contract DeployDemoMarket is MarketDeployer {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        CollateralVault vault = CollateralVault(vm.envAddress("VAULT_ADDRESS"));
        address sequencerFeed = vm.envOr("SEQUENCER_FEED_ADDRESS", address(0));

        // Read before broadcasting: a wrong or codeless VAULT_ADDRESS fails
        // here, on a static call, rather than after four contracts have been
        // paid for.
        IERC20 asset = IERC20(vault.asset());
        require(address(asset) != address(0), "vault reports no asset");

        vm.startBroadcast(deployerKey);
        deployDemoMarket(asset, vault, sequencerFeed, deployer);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== deployed ===");
        console2.log("Asset               ", address(asset));
        console2.log("CollateralVault     ", address(vault));
        console2.log("DemoPriceFeed       ", demoFeed);
        console2.log("DemoParimutuelRound ", demoMarket);
        console2.log("DemoBorrowToPosRtr  ", demoRouter);
        console2.log("deployer            ", deployer);
        console2.log("");
        console2.log("--- frontend .env.local ---");
        console2.log("NEXT_PUBLIC_DEMO_MARKET_ADDRESS=%s", vm.toString(demoMarket));
        console2.log("NEXT_PUBLIC_DEMO_ROUTER_ADDRESS=%s", vm.toString(demoRouter));
        console2.log("NEXT_PUBLIC_DEMO_FEED_ADDRESS=%s", vm.toString(demoFeed));
    }
}
