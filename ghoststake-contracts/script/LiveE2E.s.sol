// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { BorrowToPositionRouter } from "../src/BorrowToPositionRouter.sol";
import { CollateralVault } from "../src/CollateralVault.sol";
import { ParimutuelRound } from "../src/ParimutuelRound.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";

/// @notice The whole user journey, driven as real transactions against a
/// deployed chain.
///
/// Every other test in this repo runs in a Foundry VM against contracts it
/// deployed itself. This one signs and broadcasts against whatever is already
/// live, which is the only way to find out whether the deployment is wired up
/// — the router whitelisted, the borrow module set, the asset shared — rather
/// than whether the code is right.
///
/// Split into phases because a real chain has a real clock. `openPhase` runs
/// now; `lockPhase` cannot run until the lock time arrives; `settlePhase`
/// needs a feed round published after the close. On anvil the driver script
/// jumps time between them. On a public chain it waits, and the feed's
/// heartbeat sets the pace.
///
/// Assertions are `require`, so a failure reverts the broadcast and the run
/// exits non-zero. A phase that prints and returns has actually passed.
contract LiveE2E is Script {
    uint256 internal constant USDC = 1e6;

    function _env() internal view returns (MockUSDC, CollateralVault, ParimutuelRound, BorrowToPositionRouter) {
        return (
            MockUSDC(vm.envAddress("ASSET_ADDRESS")),
            CollateralVault(vm.envAddress("VAULT_ADDRESS")),
            ParimutuelRound(vm.envAddress("MARKET_ADDRESS")),
            BorrowToPositionRouter(vm.envAddress("ROUTER_ADDRESS"))
        );
    }

    /// @notice Deposit collateral and grant the router a borrow allowance.
    ///
    /// Separate from opening the round because these are several sequential
    /// transactions, and on a public chain each one costs a block. A round
    /// scheduled before them has already started by the time it is created.
    function preparePhase() external {
        (MockUSDC asset, CollateralVault vault,, BorrowToPositionRouter router) = _env();
        uint256 key = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(key);

        uint256 deposit = vm.envOr("E2E_DEPOSIT", uint256(1_000 * USDC));
        uint256 borrow = vm.envOr("E2E_BORROW", uint256(100 * USDC));
        uint256 own = vm.envOr("E2E_OWN", uint256(50 * USDC));

        vm.startBroadcast(key);
        asset.mint(me, deposit + own + 10 * USDC);
        asset.approve(address(vault), type(uint256).max);
        asset.approve(address(router), type(uint256).max);
        vault.deposit(deposit, me);
        vault.approveBorrowDelegate(address(router), borrow);
        vm.stopBroadcast();

        console2.log("collateral %s", vm.toString(vault.collateralValue(me)));
        console2.log("delegated  %s", vm.toString(vault.borrowAllowance(me, address(router))));
    }

    /// @notice Open a round, and nothing else.
    ///
    /// One transaction, so the schedule only has to outlive a single block.
    function openPhase() external {
        (, CollateralVault vault, ParimutuelRound market, BorrowToPositionRouter router) = _env();
        uint256 key = vm.envUint("PRIVATE_KEY");

        require(market.isRouter(address(router)), "router is not whitelisted on the market");
        require(address(router.vault()) == address(vault), "router points at a different vault");

        // Supplied by the caller rather than derived from `block.timestamp`.
        // During simulation that value is the *last mined block's* timestamp,
        // and on a chain that mines only when a transaction arrives — anvil
        // idling between runs — it can be minutes stale. A schedule built on
        // it is already in the past when the transaction lands.
        uint64 openTime = uint64(vm.envOr("E2E_OPEN_TIME", block.timestamp + 60));
        require(openTime >= block.timestamp, "open time is already behind the chain");

        uint64 lockTime = openTime + uint64(vm.envOr("E2E_ENTRY_WINDOW", uint256(120)));
        uint64 closeTime = lockTime + uint64(vm.envOr("E2E_OBSERVATION", uint256(120)));

        vm.startBroadcast(key);
        uint256 roundId = market.openRound(openTime, lockTime, closeTime);
        vm.stopBroadcast();

        console2.log("round      %s", vm.toString(roundId));
        console2.log("opens      %s", vm.toString(uint256(openTime)));
        console2.log("locks      %s", vm.toString(uint256(lockTime)));
        console2.log("closes     %s", vm.toString(uint256(closeTime)));
    }

    /// @notice Take both sides of a round that is already open.
    ///
    /// One side through the router with borrowed funds, the other with plain
    /// funds, so the round has something to resolve against and both
    /// settlement paths get exercised.
    function stakePhase() external {
        (MockUSDC asset, CollateralVault vault, ParimutuelRound market, BorrowToPositionRouter router) = _env();
        uint256 key = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(key);
        uint256 roundId = vm.envUint("E2E_ROUND");

        uint256 borrow = vm.envOr("E2E_BORROW", uint256(100 * USDC));
        uint256 own = vm.envOr("E2E_OWN", uint256(50 * USDC));

        uint256 lienBefore = vault.lienOf(me);
        uint256 walletBefore = asset.balanceOf(me);

        vm.startBroadcast(key);
        router.openPosition(roundId, ParimutuelRound.Side.Up, borrow, own);
        vm.stopBroadcast();

        uint256 staked = market.stakeOf(roundId, me, ParimutuelRound.Side.Up);
        require(staked == borrow + own, "stake does not match what was sent");

        uint256 lienAfter = vault.lienOf(me);
        require(lienAfter >= lienBefore + borrow, "the borrow was not recorded as debt");

        // The property the router exists for: only the wallet contribution
        // left the wallet. The borrowed funds went vault -> router -> round.
        uint256 spent = walletBefore - asset.balanceOf(me);
        require(spent == own, "borrowed funds passed through the wallet");

        console2.log("staked     %s", vm.toString(staked));
        console2.log("debt       %s", vm.toString(lienAfter));
        console2.log("wallet out %s (own contribution only)", vm.toString(spent));
    }

    /// @notice Take the opposing side, so the round can resolve rather than
    /// voiding on a thin side.
    function opposePhase() external {
        (MockUSDC asset,, ParimutuelRound market,) = _env();
        uint256 key = vm.envUint("E2E_OPPONENT_KEY");
        address them = vm.addr(key);
        uint256 roundId = vm.envUint("E2E_ROUND");
        uint256 amount = vm.envOr("E2E_OPPOSE", uint256(120 * USDC));

        vm.startBroadcast(key);
        asset.mint(them, amount);
        asset.approve(address(market), type(uint256).max);
        market.takePosition(roundId, ParimutuelRound.Side.Down, amount);
        vm.stopBroadcast();

        require(market.stakeOf(roundId, them, ParimutuelRound.Side.Down) == amount, "opposing stake missing");
        console2.log("opposed    %s", vm.toString(amount));
    }

    function lockPhase() external {
        (,, ParimutuelRound market,) = _env();
        uint256 roundId = vm.envUint("E2E_ROUND");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        market.lockRound(roundId);
        vm.stopBroadcast();

        ParimutuelRound.Round memory round = market.rounds(roundId);

        // A round can void at lock for two different reasons, and saying the
        // wrong one is worse than saying nothing: a thin side, or a lock that
        // arrived after `lockWindow` expired. Distinguish them rather than
        // guessing — an earlier version reported "one side was under the
        // minimum" for a round whose sides were both well over it.
        if (round.status == ParimutuelRound.Status.Void) {
            uint256 minSide = market.minSidePool();
            if (round.upPool < minSide || round.downPool < minSide) {
                console2.log("voided     a side was under the minimum, so there was nothing to price");
            } else {
                console2.log("voided     nobody locked it inside the lock window; every stake is refunded");
            }
            return;
        }
        require(round.lockPrice > 0, "locked without a strike price");
        console2.log("strike     %s", vm.toString(round.lockPrice));
        console2.log("phase      %s", vm.toString(uint256(market.phaseOf(roundId))));
    }

    /// @notice Resolve against a named feed round, then claim.
    ///
    /// The feed round is supplied rather than searched for: that is the whole
    /// point of GHO-14's pinning, and the keeper will have to find it the same
    /// way.
    function settlePhase() external {
        (MockUSDC asset, CollateralVault vault, ParimutuelRound market,) = _env();
        uint256 key = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(key);
        uint256 roundId = vm.envUint("E2E_ROUND");

        // A voided round has already settled — there is nothing to resolve
        // against, only a refund to collect. Resolving it would revert.
        if (market.rounds(roundId).status != ParimutuelRound.Status.Void) {
            uint80 closeRound = uint80(vm.envUint("E2E_CLOSE_ROUND"));
            vm.startBroadcast(key);
            market.resolveRound(roundId, closeRound);
            vm.stopBroadcast();

            ParimutuelRound.Round memory round = market.rounds(roundId);
            console2.log("close      %s", vm.toString(round.closePrice));
            console2.log("winner     %s", round.winner == ParimutuelRound.Side.Up ? "Up" : "Down");
        } else {
            console2.log("refund     round was voided, stake comes back in full");
        }

        uint256 claimable = market.claimableOf(roundId, me);
        if (claimable == 0) {
            console2.log("no payout for the deployer on this round");
            return;
        }

        uint256 lienBefore = vault.lienOf(me);
        uint256 walletBefore = asset.balanceOf(me);

        vm.startBroadcast(key);
        market.claim(roundId, me);
        vm.stopBroadcast();

        uint256 lienAfter = vault.lienOf(me);
        uint256 walletAfter = asset.balanceOf(me);

        // Settlement order: debt first, remainder to the user. Both halves
        // have to add up to the payout, or something was stranded.
        uint256 repaid = lienBefore > lienAfter ? lienBefore - lienAfter : 0;
        uint256 returned = walletAfter - walletBefore;
        require(repaid + returned <= claimable, "settlement paid out more than the claim");
        require(asset.balanceOf(address(vm.envAddress("ROUTER_ADDRESS"))) == 0, "router kept funds");

        console2.log("claimed    %s", vm.toString(claimable));
        console2.log("repaid     %s", vm.toString(repaid));
        console2.log("returned   %s", vm.toString(returned));
    }
}
