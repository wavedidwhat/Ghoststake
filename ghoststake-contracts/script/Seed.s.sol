// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";
import { CollateralVault } from "../src/CollateralVault.sol";
import { ParimutuelRound } from "../src/ParimutuelRound.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";

/// @notice Puts real activity on a freshly deployed local chain.
///
/// Without this the dashboard is technically working and visibly empty, which
/// is the same screen as broken. Three accounts, so the data has shape:
/// a lender, a borrower whose health factor is worth looking at, and a
/// counterparty on the other side of a round.
///
/// Reads addresses from the environment — `make seed-local` passes them
/// through from the deploy output.
contract Seed is Script {
    // anvil's prefunded accounts 0, 1, 2.
    uint256 internal constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant ALICE_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant BOB_KEY = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;

    uint256 internal constant USDC = 1e6;

    /// @dev Lead time on a round's start, to absorb the gap between
    /// simulating a transaction and it being mined.
    uint64 internal constant OPEN_LEAD = 2 minutes;

    function run() external {
        MockUSDC asset = MockUSDC(vm.envAddress("ASSET_ADDRESS"));
        BorrowLiquidityPool pool = BorrowLiquidityPool(vm.envAddress("POOL_ADDRESS"));
        CollateralVault vault = CollateralVault(vm.envAddress("VAULT_ADDRESS"));
        ParimutuelRound market = ParimutuelRound(vm.envAddress("MARKET_ADDRESS"));

        // On anvil the three prefunded accounts exist and can each sign, so
        // the seed can build a many-sided market. On any real network only
        // the deployer has gas, and the anvil keys hold nothing — so
        // everything is done from one account instead.
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", DEPLOYER_KEY);
        bool local = block.chainid == 31337;

        if (local) {
            seedLocal(asset, pool, vault, market);
        } else {
            seedSingleAccount(deployerKey, asset, pool, vault, market);
        }
    }

    /// @dev Three signers: a lender, a borrower, and a counterparty.
    function seedLocal(MockUSDC asset, BorrowLiquidityPool pool, CollateralVault vault, ParimutuelRound market)
        internal
    {
        address deployer = vm.addr(DEPLOYER_KEY);
        address alice = vm.addr(ALICE_KEY);
        address bob = vm.addr(BOB_KEY);

        vm.startBroadcast(DEPLOYER_KEY);
        asset.mint(deployer, 100_000 * USDC);
        asset.approve(address(pool), type(uint256).max);
        pool.supply(50_000 * USDC);
        vm.stopBroadcast();

        // Deposits 10,000 and draws 3,000 against it. maxLTV is 60%, so this
        // sits at half the ceiling: healthy, and low enough that the number
        // on screen is not the 999+ cap.
        vm.startBroadcast(ALICE_KEY);
        asset.mint(alice, 20_000 * USDC);
        asset.approve(address(vault), type(uint256).max);
        vault.deposit(10_000 * USDC, alice);
        vault.borrow(3_000 * USDC);
        vm.stopBroadcast();

        vm.startBroadcast(BOB_KEY);
        asset.mint(bob, 20_000 * USDC);
        asset.approve(address(vault), type(uint256).max);
        vault.deposit(4_000 * USDC, bob);
        vm.stopBroadcast();

        vm.startBroadcast(DEPLOYER_KEY);
        uint256 roundId = market.openRound(
            uint64(block.timestamp), uint64(block.timestamp + 10 minutes), uint64(block.timestamp + 20 minutes)
        );
        vm.stopBroadcast();

        vm.startBroadcast(ALICE_KEY);
        asset.approve(address(market), type(uint256).max);
        market.takePosition(roundId, ParimutuelRound.Side.Up, 500 * USDC);
        vm.stopBroadcast();

        vm.startBroadcast(BOB_KEY);
        asset.approve(address(market), type(uint256).max);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 300 * USDC);
        vm.stopBroadcast();

        report(vault, alice, "alice");
    }

    /// @dev One signer, which on a real network is whoever is paying for gas.
    ///
    /// The position lands on that same address, so connecting the wallet that
    /// ran this shows a funded dashboard immediately — no key to import and
    /// nothing to transfer.
    function seedSingleAccount(
        uint256 key,
        MockUSDC asset,
        BorrowLiquidityPool pool,
        CollateralVault vault,
        ParimutuelRound market
    ) internal {
        address me = vm.addr(key);

        vm.startBroadcast(key);
        asset.mint(me, 100_000 * USDC);

        asset.approve(address(pool), type(uint256).max);
        pool.supply(50_000 * USDC);

        asset.approve(address(vault), type(uint256).max);
        vault.deposit(10_000 * USDC, me);
        vault.borrow(3_000 * USDC);

        // `openTime` is given a lead, because `openRound` rejects a start in
        // the past and `block.timestamp` here is the *simulated* block's.
        // On a real chain the transaction lands a block or two later, by
        // which point "now" has moved and the schedule is already invalid.
        // anvil hides this by mining instantly.
        uint64 openTime = uint64(block.timestamp) + OPEN_LEAD;
        uint256 roundId = market.openRound(openTime, openTime + 30 minutes, openTime + 60 minutes);

        // No position is taken here: entry is not open until `openTime`, and
        // every transaction in this script lands within seconds of the last.
        // The round is left for a wallet to enter through the UI.
        asset.approve(address(market), type(uint256).max);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== seeded ===");
        console2.log("everything on   %s", vm.toString(me));
        console2.log("  50,000 supplied to the pool");
        console2.log("  10,000 deposited, 3,000 borrowed");
        console2.log("  round #%s opens in 2 minutes, no positions yet", vm.toString(roundId));
        report(vault, me, "you");
    }

    function report(CollateralVault vault, address who, string memory label) internal view {
        console2.log("");
        console2.log("%s %s", label, vm.toString(who));
        console2.log("  collateralValue %s", vm.toString(vault.collateralValue(who)));
        console2.log("  lien            %s", vm.toString(vault.lienOf(who)));
        console2.log("  healthFactor    %s", vm.toString(vault.healthFactor(who)));
    }
}
