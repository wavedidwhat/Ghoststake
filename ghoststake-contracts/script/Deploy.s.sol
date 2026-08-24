// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";
import { CollateralVault, ILienSource } from "../src/CollateralVault.sol";
import { ChainlinkRoundOracle } from "../src/ChainlinkRoundOracle.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";
import { BorrowToPositionRouter } from "../src/BorrowToPositionRouter.sol";
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
        // A real Chainlink feed where one is given. Otherwise a mock, seeded
        // with a round so the adapter has something to read — an empty feed
        // reads as unavailable, which is correct but leaves the first round
        // un-lockable.
        address feed = existingFeed;
        if (feed == address(0)) {
            MockAggregatorV3 mockFeed = new MockAggregatorV3(8);
            mockFeed.push(2000e8, block.timestamp);
            feed = address(mockFeed);
        }

        ChainlinkRoundOracle oracle = new ChainlinkRoundOracle(
            AggregatorV3Interface(feed),
            // Zero disables the check. Correct on an L1 and on a local chain,
            // and WRONG on any L2 — on Arbitrum or Robinhood Chain this must
            // be the real uptime feed or downtime settles rounds against a
            // market nobody could reach.
            AggregatorV3Interface(sequencerFeed),
            vm.envOr("MAX_STALENESS", uint256(1 hours)),
            vm.envOr("SEQUENCER_GRACE", uint256(30 minutes))
        );

        ParimutuelRound market = new ParimutuelRound(
            asset,
            IRoundOracle(address(oracle)),
            0.02e18, // 2% protocol rake
            ParimutuelRound.Timing({ entryCutoff: 15 seconds, lockWindow: 60 seconds, resolveDeadline: 1 hours }),
            10e6, // min side pool: 10 mUSDC, at 6 decimals
            deployer
        );

        // The router is what joins the two halves. Whitelisting it is the
        // owner's act, so it happens here rather than in the constructor.
        BorrowToPositionRouter router = new BorrowToPositionRouter(vault, market);
        market.setRouter(address(router), true);

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
        console2.log("deployer            ", deployer);
        console2.log("");
        console2.log("--- frontend .env.local ---");
        console2.log("NEXT_PUBLIC_VAULT_ADDRESS=%s", vm.toString(address(vault)));
        console2.log("NEXT_PUBLIC_POOL_ADDRESS=%s", vm.toString(address(pool)));
        console2.log("");
        console2.log("--- backend .env ---");
        console2.log("VAULT_ADDRESS=%s", vm.toString(address(vault)));
        console2.log("POOL_ADDRESS=%s", vm.toString(address(pool)));
        console2.log("INDEXER_START_BLOCK=%s", vm.toString(block.number));
        console2.log("INDEXER_ENABLED=true");
    }

    /// @dev An APR in whole percent to the per-second WAD rate the contracts
    /// take. Simple, not compounded, matching how the contracts accrue.
    function perSecond(uint256 aprPercent) internal pure returns (uint256) {
        return (aprPercent * WAD) / 100 / YEAR;
    }
}
