// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";
import { CollateralVault, ILienSource } from "../src/CollateralVault.sol";
import { ChainlinkRoundOracle } from "../src/ChainlinkRoundOracle.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";
import { AggregatorV3Interface } from "../src/interfaces/AggregatorV3Interface.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";
import { MockAggregatorV3 } from "../test/mocks/MockAggregatorV3.sol";

/// @notice Deploys the whole stack to a local chain.
///
/// Run with `make deploy-local` from the repo root, which starts anvil first.
///
/// The mocks (`MockUSDC`, `MockAggregatorV3`) are the only things here that
/// change for a real network: on a testnet the asset is a real ERC-20 and the
/// aggregator is a real Chainlink feed address. Everything else — the
/// parameters, the ordering, the cross-wiring — is what a testnet deploy runs
/// too, which is the point of proving it locally first.
contract Deploy is Script {
    // A year in seconds, for turning APRs into the per-second WAD rates these
    // contracts take. Writing `5% APR` in the config and converting here
    // beats committing a bare 1585489599 that nobody can sanity-check.
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant WAD = 1e18;

    function run() external {
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey == 0) {
            // anvil's first prefunded account. Only ever correct locally, and
            // stated out loud rather than hidden in a default.
            deployerKey = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
            console2.log("PRIVATE_KEY unset: using anvil account 0");
        }
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        MockUSDC asset = new MockUSDC();

        // --- Lending ------------------------------------------------------
        //
        // Order is forced: the vault takes its lien source as a constructor
        // immutable, so the pool must exist first. The pool then needs to be
        // told which contract may borrow on users' behalf, and that setter is
        // one-shot — see BorrowModuleAlreadySet.
        BorrowLiquidityPool pool = new BorrowLiquidityPool(
            IERC20(address(asset)),
            perSecond(2), // base rate, 2% APR at zero utilization
            perSecond(8), // slope 1, gentle up to the kink
            perSecond(100), // slope 2, punishing past it
            0.8e18, // kink at 80% utilization
            0.1e18, // 10% of borrower interest to reserves
            deployer
        );

        CollateralVault vault = new CollateralVault(
            IERC20(address(asset)),
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
        // A mock feed standing in for Chainlink. Seeded with one round so the
        // adapter has something to read: an empty feed reads as unavailable,
        // which is correct but makes the first round un-lockable.
        MockAggregatorV3 feed = new MockAggregatorV3(8);
        feed.push(2000e8, block.timestamp);

        ChainlinkRoundOracle oracle = new ChainlinkRoundOracle(
            AggregatorV3Interface(address(feed)),
            // No sequencer uptime feed locally. Correct here and wrong on any
            // L2 — on Robinhood Chain or Arbitrum this must be the real one.
            AggregatorV3Interface(address(0)),
            1 hours, // max staleness
            30 minutes // sequencer recovery grace
        );

        ParimutuelRound market = new ParimutuelRound(
            IERC20(address(asset)),
            IRoundOracle(address(oracle)),
            0.02e18, // 2% protocol rake
            ParimutuelRound.Timing({ entryCutoff: 15 seconds, lockWindow: 60 seconds, resolveDeadline: 1 hours }),
            10e6, // min side pool: 10 mUSDC, at 6 decimals
            deployer
        );

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== deployed ===");
        console2.log("MockUSDC            ", address(asset));
        console2.log("BorrowLiquidityPool ", address(pool));
        console2.log("CollateralVault     ", address(vault));
        console2.log("MockAggregatorV3    ", address(feed));
        console2.log("ChainlinkRoundOracle", address(oracle));
        console2.log("ParimutuelRound     ", address(market));
        console2.log("deployer            ", deployer);
        console2.log("");
        console2.log("--- frontend .env.local ---");
        console2.log("NEXT_PUBLIC_VAULT_ADDRESS=%s", vm.toString(address(vault)));
        console2.log("NEXT_PUBLIC_POOL_ADDRESS=%s", vm.toString(address(pool)));
        console2.log("");
        console2.log("--- backend .env ---");
        console2.log("VAULT_ADDRESS=%s", vm.toString(address(vault)));
        console2.log("POOL_ADDRESS=%s", vm.toString(address(pool)));
        console2.log("INDEXER_START_BLOCK=1");
        console2.log("INDEXER_ENABLED=true");
    }

    /// @dev An APR in whole percent to the per-second WAD rate the contracts
    /// take. Simple, not compounded, matching how the contracts accrue.
    function perSecond(uint256 aprPercent) internal pure returns (uint256) {
        return (aprPercent * WAD) / 100 / YEAR;
    }
}
