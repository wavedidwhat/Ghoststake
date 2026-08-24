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

    function run() external {
        MockUSDC asset = MockUSDC(vm.envAddress("ASSET_ADDRESS"));
        BorrowLiquidityPool pool = BorrowLiquidityPool(vm.envAddress("POOL_ADDRESS"));
        CollateralVault vault = CollateralVault(vm.envAddress("VAULT_ADDRESS"));
        ParimutuelRound market = ParimutuelRound(vm.envAddress("MARKET_ADDRESS"));

        address deployer = vm.addr(DEPLOYER_KEY);
        address alice = vm.addr(ALICE_KEY);
        address bob = vm.addr(BOB_KEY);

        // --- Lender: fills the pool so there is something to borrow --------
        vm.startBroadcast(DEPLOYER_KEY);
        asset.mint(deployer, 100_000 * USDC);
        asset.approve(address(pool), type(uint256).max);
        pool.supply(50_000 * USDC);
        vm.stopBroadcast();

        // --- Borrower: a position with a health factor worth reading -------
        //
        // Deposits 10,000 and draws 3,000 against it. maxLTV is 60%, so this
        // sits at half the ceiling: comfortably healthy, and low enough that
        // the number on screen is not 999+.
        vm.startBroadcast(ALICE_KEY);
        asset.mint(alice, 20_000 * USDC);
        asset.approve(address(vault), type(uint256).max);
        vault.deposit(10_000 * USDC, alice);
        vault.borrow(3_000 * USDC);
        vm.stopBroadcast();

        // --- A second depositor, so the vault is not one account -----------
        vm.startBroadcast(BOB_KEY);
        asset.mint(bob, 20_000 * USDC);
        asset.approve(address(vault), type(uint256).max);
        vault.deposit(4_000 * USDC, bob);
        vm.stopBroadcast();

        // --- An open round with both sides taken ---------------------------
        //
        // Opens now, locks in 10 minutes, closes 10 minutes after that. Long
        // enough that it is still OPEN when someone looks at it, rather than
        // already past its entry cutoff.
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

        console2.log("");
        console2.log("=== seeded ===");
        console2.log("pool supplied        50,000 mUSDC by deployer");
        console2.log("alice  deposited     10,000 mUSDC, borrowed 3,000");
        console2.log("bob    deposited      4,000 mUSDC");
        console2.log("round #%s open, Up 500 / Down 300", vm.toString(roundId));
        console2.log("");
        console2.log("alice %s", vm.toString(alice));
        console2.log("  collateralValue %s", vm.toString(vault.collateralValue(alice)));
        console2.log("  lien            %s", vm.toString(vault.lienOf(alice)));
        console2.log("  healthFactor    %s", vm.toString(vault.healthFactor(alice)));
        console2.log("bob   %s", vm.toString(bob));
    }
}
