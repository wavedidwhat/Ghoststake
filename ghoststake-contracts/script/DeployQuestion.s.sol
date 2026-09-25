// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { CollateralVault } from "../src/CollateralVault.sol";
import { EventRoundOracle } from "../src/EventRoundOracle.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";
import { BorrowToPositionRouter } from "../src/BorrowToPositionRouter.sol";
import { MarketRegistry } from "../src/MarketRegistry.sol";

/// @notice Deploys one question, the market on it, and its single round
/// (GHO-91).
///
///     VAULT_ADDRESS=0x… ARBITER_ADDRESS=0x… \
///     QUESTION="Brazil win the 2026 World Cup" \
///     CRITERIA_URI="https://…/criteria.md" \
///     CRITERIA_DIGEST=0x… \
///     EVENT_TIME=1783900800 CLOSE_TIME=1783987200 \
///       forge script script/DeployQuestion.s.sol:DeployQuestion \
///       --rpc-url "$RPC_URL" --broadcast --slow
///
/// # The round is opened here, not by the keeper
///
/// Every other market opens rounds on a cadence and the keeper drives it. A
/// question is asked once: there is one round, its close time is when the
/// event has happened rather than a horizon from now, and a keeper that
/// applied its cadence rule would open a second round the moment the first
/// settled — on a question that already has an answer. So the round is part
/// of the deployment, and the keeper's job here is only to lock and settle
/// it.
///
/// # Why the strike is a sentinel
///
/// `ParimutuelRound` settles by comparing a close price against a strike, and
/// that comparison is audited, live, and already carries the rake, the void
/// rules and the claim maths. An outcome is mapped onto it — strike 1e18, Yes
/// 2e18, No 0 — so an event market is the *same* contract as a price market.
/// The strike below is read from the oracle rather than written as `1e18`,
/// because two copies of that number in two languages is exactly how a
/// settled question comes to pay the wrong side silently.
contract DeployQuestion is Script {
    /// @dev Where the three new contracts landed.
    ///
    /// Storage rather than locals, for the reason `MarketDeployer` gives:
    /// deploying an oracle, a market and a router in one function exhausts
    /// the stack, and "Stack too deep" is a compiler error that says nothing
    /// about what the script was trying to do.
    EventRoundOracle internal oracle;
    ParimutuelRound internal market;
    BorrowToPositionRouter internal router;
    uint256 internal roundId;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        CollateralVault vault = CollateralVault(vm.envAddress("VAULT_ADDRESS"));

        // Read before broadcasting, so a wrong address fails on a static call
        // rather than after three contracts have been paid for.
        IERC20 asset = IERC20(vault.asset());
        require(address(asset) != address(0), "vault reports no asset");

        vm.startBroadcast(deployerKey);
        deployOracle(asset, deployer);
        deployMarketOnIt(asset, vault, deployer);
        vm.stopBroadcast();

        report(deployer);
    }

    /// @dev The question itself.
    function deployOracle(IERC20 asset, address deployer) internal {
        uint64 eventTime = uint64(vm.envUint("EVENT_TIME"));

        oracle = new EventRoundOracle(
            deployer,
            vm.envAddress("ARBITER_ADDRESS"),
            asset,
            // The bond, in the asset's own units. Defaulted rather than
            // derived: what it has to do is make challenging worth it, and a
            // challenger who is right takes the liar's bond — so tens of
            // dollars clears the cost of reading the evidence and sending one
            // transaction by orders of magnitude. A question settling a large
            // market should raise it.
            vm.envOr("QUESTION_BOND", uint256(50e6)),
            eventTime,
            uint64(vm.envOr("CHALLENGE_WINDOW", uint256(2 days))),
            uint64(vm.envOr("RULING_DEADLINE", uint256(3 days))),
            vm.envString("QUESTION"),
            vm.envString("CRITERIA_URI"),
            vm.envBytes32("CRITERIA_DIGEST")
        );
    }

    /// @dev The market on it, its one round, and the listing.
    function deployMarketOnIt(IERC20 asset, CollateralVault vault, address deployer) internal {
        uint64 eventTime = uint64(vm.envUint("EVENT_TIME"));
        uint64 closeTime = uint64(vm.envUint("CLOSE_TIME"));
        // Entry closes when the event does at the latest. A round still
        // taking bets while the result is on television is not a market.
        uint64 lockTime = uint64(vm.envOr("LOCK_TIME", uint256(eventTime)));
        require(lockTime <= eventTime, "entry must close by the event");
        require(closeTime > eventTime, "the round must close after the event");

        market = new ParimutuelRound(
            asset,
            IRoundOracle(address(oracle)),
            0.02e18, // 2% protocol rake, the same as every other market
            // The lock window is wide here on purpose. On a price market it
            // bounds how long a late lock can wait before the strike would be
            // stale; since GHO-79 the strike is fixed at open and there is
            // nothing for a late caller to pick, so the only thing a tight
            // window buys on a question is a round that voids because nobody
            // sent a transaction within the minute.
            ParimutuelRound.Timing({ entryCutoff: 1 minutes, lockWindow: 1 days, resolveDeadline: 14 days }),
            10e6, // min side pool: 10 mUSDC, at 6 decimals
            deployer,
            vm.envOr("PAUSE_GUARDIAN", deployer)
        );

        router = new BorrowToPositionRouter(vault, market);
        market.setRouter(address(router), true);

        roundId = market.openRound(uint64(block.timestamp), lockTime, closeTime, oracle.STRIKE());

        // Pointing the oracle at the round it settles. Owner-only and once
        // only, and it must happen before anybody proposes — which is why it
        // is here rather than left as a step somebody has to remember.
        oracle.setMarket(address(market), roundId);

        address registry = vm.envOr("REGISTRY_ADDRESS", address(0));
        if (registry != address(0)) {
            // The horizon is advisory and means nothing for a question, which
            // opens no further rounds. Set to the round's own length so a
            // listing that does show it shows something true.
            MarketRegistry(registry).list(market, router, uint64(closeTime - block.timestamp));
        }
    }

    function report(address deployer) internal view {
        console2.log("");
        console2.log("=== question deployed ===");
        console2.log("Question            ", oracle.question());
        console2.log("EventRoundOracle    ", address(oracle));
        console2.log("ParimutuelRound     ", address(market));
        console2.log("BorrowToPositionRtr ", address(router));
        console2.log("Arbiter             ", oracle.arbiter());
        console2.log("Round id            ", roundId);
        console2.log("Bond                ", oracle.bond());
        console2.log("deployer            ", deployer);
        console2.log("");
        console2.log("--- backend .env ---");
        // The indexer is told the pair rather than reading it, because its
        // stream identity is fixed before any RPC call. The decoder checks
        // this against the oracle's own MarketSet log and refuses a mismatch.
        console2.log(
            "EVENT_ORACLES=%s:%s:%s", vm.toString(address(oracle)), vm.toString(address(market)), vm.toString(roundId)
        );
        console2.log("MARKET_ADDRESSES: append %s", vm.toString(address(market)));
    }
}
