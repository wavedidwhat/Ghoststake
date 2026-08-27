// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";
import { BorrowToPositionRouter } from "../src/BorrowToPositionRouter.sol";
import { CollateralVault, ILienSource } from "../src/CollateralVault.sol";
import { MarketRegistry } from "../src/MarketRegistry.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";
import { MockRoundOracle } from "./mocks/MockRoundOracle.sol";

/// @notice GHO-34: the list of markets the app offers.
///
/// The registry holds no money and cannot move any, so what is worth testing
/// is not safety but *truthfulness*: that it refuses to list a pairing that
/// would fail for users, that delisting hides a market without touching it,
/// and that the read a frontend depends on returns everything it needs in one
/// call.
contract MarketRegistryTest is Test {
    uint256 internal constant YEAR = 365 days;

    MarketRegistry internal registry;
    CollateralVault internal vault;
    BorrowLiquidityPool internal pool;
    ERC20Mock internal token;

    address internal owner = makeAddr("owner");
    address internal outsider = makeAddr("outsider");

    function setUp() public {
        token = new ERC20Mock();
        pool = new BorrowLiquidityPool(
            IERC20(address(token)), 0, uint256(4e16) / YEAR, uint256(75e16) / YEAR, 8e17, 1e17, owner, owner
        );
        vault = new CollateralVault(
            IERC20(address(token)),
            uint256(5e16) / YEAR,
            ILienSource(address(pool)),
            CollateralVault.RiskParams({
                maxLTV: 5e17,
                liquidationThreshold: 65e16,
                liquidationBonus: 5e16,
                closeFactor: 5e17
            }),
            address(this)
        );
        vm.prank(owner);
        pool.setBorrowModule(address(vault));

        registry = new MarketRegistry(owner);
    }

    /// @dev A market and a router wired the way a deploy wires them.
    function _market() internal returns (ParimutuelRound market, BorrowToPositionRouter router) {
        market = new ParimutuelRound(
            IERC20(address(token)),
            IRoundOracle(address(new MockRoundOracle(2000e18))),
            2e16,
            ParimutuelRound.Timing({ entryCutoff: 15, lockWindow: 60, resolveDeadline: 1 hours }),
            1 ether,
            owner,
            owner
        );
        router = new BorrowToPositionRouter(vault, market);
        vm.prank(owner);
        market.setRouter(address(router), true);
    }

    // ------------------------------------------------------------------
    // Listing
    // ------------------------------------------------------------------

    function test_listsAMarketAndFindsItAgain() public {
        (ParimutuelRound market, BorrowToPositionRouter router) = _market();

        vm.prank(owner);
        uint256 id = registry.list(market, router, 5 minutes);

        assertEq(id, 0);
        assertEq(registry.count(), 1);

        MarketRegistry.Listing memory listing = registry.at(id);
        assertEq(address(listing.market), address(market));
        assertEq(address(listing.router), address(router));
        assertEq(listing.horizon, 5 minutes);
        assertTrue(listing.enabled, "a market is listed enabled");

        (bool listed, uint256 foundId) = registry.find(address(market));
        assertTrue(listed);
        assertEq(foundId, id);
    }

    function test_listingIsOwnerOnly() public {
        (ParimutuelRound market, BorrowToPositionRouter router) = _market();

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        registry.list(market, router, 5 minutes);
    }

    function test_refusesARouterBoundToADifferentMarket() public {
        // The failure this prevents: the router binds its market as an
        // immutable, so this pairing would route a borrow into the *other*
        // market and the user's position would appear somewhere they were not
        // looking.
        (ParimutuelRound market,) = _market();
        (, BorrowToPositionRouter otherRouter) = _market();

        // Read before the prank, not inside `expectRevert`'s arguments.
        // `otherRouter.market()` is an external call, and an armed prank is
        // spent by the next call of any kind — so building the expected error
        // inline consumed it, and the revert under test became
        // OwnableUnauthorizedAccount from an unpranked caller.
        address itsMarket = address(otherRouter.market());

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(MarketRegistry.RouterServesAnotherMarket.selector, address(otherRouter), itsMarket)
        );
        registry.list(market, otherRouter, 5 minutes);
    }

    function test_refusesARouterTheMarketHasNotWhitelisted() public {
        // `takePositionFor` reverts with NotRouter, so listing this pair
        // would ship a borrow-to-position button that fails for everyone.
        ParimutuelRound market = new ParimutuelRound(
            IERC20(address(token)),
            IRoundOracle(address(new MockRoundOracle(2000e18))),
            2e16,
            ParimutuelRound.Timing({ entryCutoff: 15, lockWindow: 60, resolveDeadline: 1 hours }),
            1 ether,
            owner,
            owner
        );
        BorrowToPositionRouter router = new BorrowToPositionRouter(vault, market);
        // Deliberately not whitelisted.

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(MarketRegistry.RouterNotWhitelisted.selector, address(market), address(router))
        );
        registry.list(market, router, 5 minutes);
    }

    function test_refusesADuplicateMarket() public {
        (ParimutuelRound market, BorrowToPositionRouter router) = _market();

        vm.startPrank(owner);
        registry.list(market, router, 5 minutes);
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.AlreadyListed.selector, address(market)));
        registry.list(market, router, 10 minutes);
        vm.stopPrank();
    }

    function test_refusesZeroes() public {
        (ParimutuelRound market, BorrowToPositionRouter router) = _market();

        vm.startPrank(owner);
        vm.expectRevert(MarketRegistry.ZeroAddress.selector);
        registry.list(ParimutuelRound(address(0)), router, 5 minutes);

        vm.expectRevert(MarketRegistry.ZeroAddress.selector);
        registry.list(market, BorrowToPositionRouter(address(0)), 5 minutes);

        // A zero horizon is not "unspecified", it is a market claiming rounds
        // of no length. Refused rather than rendered.
        vm.expectRevert(MarketRegistry.ZeroHorizon.selector);
        registry.list(market, router, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Delisting
    // ------------------------------------------------------------------

    function test_delistingHidesAMarketWithoutTouchingIt() public {
        (ParimutuelRound market, BorrowToPositionRouter router) = _market();

        vm.startPrank(owner);
        uint256 id = registry.list(market, router, 5 minutes);
        registry.setEnabled(id, false);
        vm.stopPrank();

        assertFalse(registry.at(id).enabled);

        // The point: a delisted market is not a paused one. It still opens
        // rounds, and anyone holding a position in it is unaffected.
        vm.prank(owner);
        uint256 roundId =
            market.openRound(uint64(block.timestamp), uint64(block.timestamp + 300), uint64(block.timestamp + 600));
        assertEq(roundId, 1);
        assertTrue(market.entryIsOpen(roundId));
    }

    function test_delistedMarketsAreStillReturnedByAll() public {
        // A holder of a position in a delisted market has to be able to find
        // it. A read that quietly drops rows makes that impossible, so
        // filtering is the caller's job and never this contract's.
        (ParimutuelRound a, BorrowToPositionRouter ra) = _market();
        (ParimutuelRound b, BorrowToPositionRouter rb) = _market();

        vm.startPrank(owner);
        registry.list(a, ra, 5 minutes);
        uint256 second = registry.list(b, rb, 1 hours);
        registry.setEnabled(second, false);
        vm.stopPrank();

        MarketRegistry.Listing[] memory all = registry.all();
        assertEq(all.length, 2);
        assertTrue(all[0].enabled);
        assertFalse(all[1].enabled);
        assertEq(address(all[1].market), address(b));
    }

    function test_delistingAndHorizonAreOwnerOnly() public {
        (ParimutuelRound market, BorrowToPositionRouter router) = _market();
        vm.prank(owner);
        uint256 id = registry.list(market, router, 5 minutes);

        vm.startPrank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        registry.setEnabled(id, false);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        registry.setHorizon(id, 1 hours);
        vm.stopPrank();
    }

    function test_horizonCanBeRestated() public {
        (ParimutuelRound market, BorrowToPositionRouter router) = _market();

        vm.startPrank(owner);
        uint256 id = registry.list(market, router, 5 minutes);
        registry.setHorizon(id, 1 hours);
        assertEq(registry.at(id).horizon, 1 hours);

        vm.expectRevert(MarketRegistry.ZeroHorizon.selector);
        registry.setHorizon(id, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    function test_unknownListingsRevertRatherThanReturningAnEmptyRow() public {
        // An empty struct reads as a market at the zero address, which a UI
        // renders as a real market holding nothing.
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.UnknownListing.selector, uint256(0)));
        registry.at(0);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.UnknownListing.selector, uint256(7)));
        registry.setEnabled(7, true);
        vm.stopPrank();
    }

    function test_findSaysNoForAMarketThatWasNeverListed() public {
        (ParimutuelRound market,) = _market();
        (bool listed, uint256 id) = registry.find(address(market));
        assertFalse(listed);
        assertEq(id, 0, "id is meaningless when listed is false, and zero is a real id");
    }

    function test_allReturnsEverythingInOneCall() public {
        // Deployed before the prank: `_market` pranks the owner itself to
        // whitelist the router, and Foundry refuses a prank inside a prank.
        ParimutuelRound[5] memory ms;
        BorrowToPositionRouter[5] memory rs;
        for (uint256 i = 0; i < 5; i++) {
            (ms[i], rs[i]) = _market();
        }

        vm.startPrank(owner);
        for (uint256 i = 0; i < 5; i++) {
            registry.list(ms[i], rs[i], uint64(5 minutes * (i + 1)));
        }
        vm.stopPrank();

        MarketRegistry.Listing[] memory all = registry.all();
        assertEq(all.length, 5);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(all[i].horizon, uint64(5 minutes * (i + 1)));
        }
    }
}
