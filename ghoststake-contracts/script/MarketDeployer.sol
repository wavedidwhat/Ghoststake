// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { CollateralVault } from "../src/CollateralVault.sol";
import { ChainlinkRoundOracle } from "../src/ChainlinkRoundOracle.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";
import { BorrowToPositionRouter } from "../src/BorrowToPositionRouter.sol";
import { AggregatorV3Interface } from "../src/interfaces/AggregatorV3Interface.sol";
import { DemoPriceFeed } from "../src/demo/DemoPriceFeed.sol";
import { MarketRegistry } from "../src/MarketRegistry.sol";

/// @notice How a market is deployed, shared by every script that deploys one.
///
/// There are two callers — the full-stack `Deploy`, and `DeployDemoMarket`,
/// which adds a demo market to a deployment that already exists. They have to
/// produce the same market: the demo one proves something about the real one
/// only if the two are the same contracts with the same parameters, differing
/// in nothing but who publishes the price. Two copies of these constructor
/// arguments would be two things to keep in step, and the first one to drift
/// would make the demo a demonstration of something we do not ship.
///
/// A base contract rather than a library because everything here deploys, and
/// `vm.envOr` needs the script context.
abstract contract MarketDeployer is Script {
    /// @dev Where a demo market landed, for the caller to print. Storage
    /// rather than return values: `Deploy.run` already deploys enough
    /// contracts to exhaust the stack.
    address internal demoFeed;
    address internal demoMarket;
    address internal demoRouter;

    /// @dev Listing a market where a registry exists, and doing nothing where
    /// one does not. Passing `address(0)` is the normal case for a deployment
    /// that predates the registry, not an error — the frontend falls back to
    /// its environment there.
    function listIfPossible(address registry, ParimutuelRound market, BorrowToPositionRouter router, uint64 horizon)
        internal
    {
        if (registry == address(0)) return;
        MarketRegistry(registry).list(market, router, horizon);
    }

    /// @dev The second market, on a feed the deployer publishes into on cue.
    ///
    /// Everything about it is the real deployment except the publisher, which
    /// is the only way the demo proves anything: if the demo market ran
    /// different code, a round settling there would say nothing about the
    /// round that has to settle on Chainlink.
    function deployDemoMarket(IERC20 asset, CollateralVault vault, address sequencerFeed, address owner) internal {
        DemoPriceFeed feed = new DemoPriceFeed(8, vm.envOr("DEMO_ASSET_LABEL", string("ETH / USD")), owner);
        // Seeded for the same reason the local feed is: the strike read is
        // `readLatest`, so the feed has to be publishing before the first
        // round opens or that round voids at lock for a reason that has
        // nothing to do with the market.
        feed.push(2000e8);

        (, ParimutuelRound market, BorrowToPositionRouter router) =
            deployMarket(asset, vault, address(feed), sequencerFeed, owner);

        demoFeed = address(feed);
        demoMarket = address(market);
        demoRouter = address(router);
    }

    /// @dev One market: the Chainlink adapter over `feed`, the round contract
    /// on top of it, and the router that lets a borrow become a position in
    /// one transaction.
    ///
    /// Factored out because the demo market is not a variant of the real one —
    /// it is the same deployment with a different feed underneath, and any
    /// parameter that drifted between the two would make the demo a
    /// demonstration of something we do not ship.
    function deployMarket(IERC20 asset, CollateralVault vault, address feed, address sequencerFeed, address owner)
        internal
        returns (ChainlinkRoundOracle oracle, ParimutuelRound market, BorrowToPositionRouter router)
    {
        oracle = new ChainlinkRoundOracle(
            AggregatorV3Interface(feed),
            // Zero disables the check. Correct on an L1 and on a local chain,
            // and WRONG on any L2 — on Arbitrum or Robinhood Chain this must
            // be the real uptime feed or downtime settles rounds against a
            // market nobody could reach.
            AggregatorV3Interface(sequencerFeed),
            vm.envOr("MAX_STALENESS", uint256(1 hours)),
            vm.envOr("SEQUENCER_GRACE", uint256(30 minutes))
        );

        market = new ParimutuelRound(
            asset,
            IRoundOracle(address(oracle)),
            0.02e18, // 2% protocol rake
            ParimutuelRound.Timing({ entryCutoff: 15 seconds, lockWindow: 60 seconds, resolveDeadline: 1 hours }),
            10e6, // min side pool: 10 mUSDC, at 6 decimals
            owner,
            // The pause guardian (GHO-31), read here rather than threaded
            // through three call sites. Defaults to the owner, which is what
            // every caller passes today; the point of the variable is that a
            // real deployment can separate the hot halting key from the cold
            // one that moves reserves.
            vm.envOr("PAUSE_GUARDIAN", owner)
        );

        // The router is what joins the two halves. Whitelisting it is the
        // owner's act, so it happens here rather than in the constructor.
        router = new BorrowToPositionRouter(vault, market);
        market.setRouter(address(router), true);
    }
}
