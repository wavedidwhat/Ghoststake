// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";

import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";
import { Treasured } from "../src/Treasured.sol";
import { MockRoundOracle } from "./mocks/MockRoundOracle.sol";

/// @dev GHO-40. Where the protocol's earnings go used to be a parameter on the
/// withdrawal call, so the answer to "who receives the rake" was "whoever the
/// owner types, at the moment they type it". These pin the replacement.
contract TreasuryTest is Test {
    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal multisig = makeAddr("multisig");

    ERC20Mock internal token;
    ParimutuelRound internal market;
    BorrowLiquidityPool internal pool;

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new ERC20Mock();
        MockRoundOracle oracle = new MockRoundOracle(2000e8);

        market = new ParimutuelRound(
            IERC20(address(token)),
            IRoundOracle(address(oracle)),
            0.02e18,
            ParimutuelRound.Timing({ entryCutoff: 15, lockWindow: 60, resolveDeadline: 600 }),
            10e18,
            owner,
            owner
        );

        pool = new BorrowLiquidityPool(
            IERC20(address(token)), 0, 0.05e18 / uint256(365 days), 0, 0.8e18, 0.1e18, owner, owner
        );
    }

    // ---------------------------------------------------------------
    // The default
    // ---------------------------------------------------------------

    /// @dev The owner was already the only address that could decide where the
    /// money went, so starting there changes nothing about who is trusted —
    /// and it keeps the constructor signatures unchanged, which is what a
    /// redeploy has to get right.
    function test_treasuryDefaultsToTheOwner() public view {
        assertEq(market.treasury(), owner);
        assertEq(pool.treasury(), owner);
    }

    function test_constructionAnnouncesTheDefault() public {
        vm.expectEmit(true, true, false, false);
        emit Treasured.TreasurySet(address(0), owner);
        new BorrowLiquidityPool(IERC20(address(token)), 0, 0.05e18 / uint256(365 days), 0, 0.8e18, 0.1e18, owner, owner);
    }

    // ---------------------------------------------------------------
    // Setting it
    // ---------------------------------------------------------------

    function test_ownerCanRepointTheTreasury() public {
        vm.prank(owner);
        market.setTreasury(multisig);
        assertEq(market.treasury(), multisig);
    }

    /// @dev The whole point of storing it. A destination that could be changed
    /// silently would be no better than the parameter it replaced: what
    /// matters is that the choice is on the record *before* the money moves,
    /// rather than inside the transaction that moves it.
    function test_repointingIsAnnounced() public {
        vm.expectEmit(true, true, false, false);
        emit Treasured.TreasurySet(owner, multisig);
        vm.prank(owner);
        market.setTreasury(multisig);
    }

    function test_strangerCannotRepointTheTreasury() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        market.setTreasury(stranger);
    }

    /// @dev Renouncing a treasury has no meaning — there is nobody to pay, and
    /// a zero destination would make every withdrawal burn the earnings.
    function test_treasuryCannotBeSetToZero() public {
        vm.prank(owner);
        vm.expectRevert(Treasured.ZeroTreasury.selector);
        market.setTreasury(address(0));

        vm.prank(owner);
        vm.expectRevert(Treasured.ZeroTreasury.selector);
        pool.setTreasury(address(0));
    }

    // ---------------------------------------------------------------
    // Withdrawing to it
    // ---------------------------------------------------------------

    /// @dev The behaviour change this issue is about: the owner no longer
    /// names a destination, so an owner who wants the rake elsewhere has to
    /// say so first, in a transaction that emits.
    function test_rakeGoesToTheTreasuryAndNowhereElse() public {
        _settleARound();
        uint256 fees = market.protocolFees();
        assertGt(fees, 0, "the round should have taken rake");

        vm.prank(owner);
        market.setTreasury(multisig);
        vm.prank(owner);
        market.withdrawFees(fees);

        assertEq(token.balanceOf(multisig), fees);
        assertEq(token.balanceOf(owner), 0, "the caller received nothing");
        assertEq(market.protocolFees(), 0);
    }

    /// @dev The bound that makes the owner power narrow, asserted rather than
    /// left in a comment: `withdrawFees` is capped by `protocolFees` and not
    /// by the token balance, so stakes still owed to users are unreachable —
    /// including from a round that is resolved but unclaimed.
    function test_ownerCannotReachStakesStillOwed() public {
        uint256 roundId = _settleARound();
        uint256 fees = market.protocolFees();
        uint256 held = token.balanceOf(address(market));
        assertGt(held, fees, "there should be unclaimed winnings sitting here");

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.InsufficientFees.selector, fees + 1, fees));
        market.withdrawFees(fees + 1);

        // And the winner is still paid in full afterwards.
        vm.prank(owner);
        market.withdrawFees(fees);
        uint256 claimable = market.claimableOf(roundId, address(this));
        market.claim(roundId, address(this));
        assertEq(token.balanceOf(address(this)), claimable);
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    /// One round, both sides filled, resolved up. `address(this)` wins.
    function _settleARound() internal returns (uint256 roundId) {
        address loser = makeAddr("loser");
        token.mint(address(this), 100e18);
        token.mint(loser, 100e18);
        token.approve(address(market), type(uint256).max);
        vm.prank(loser);
        token.approve(address(market), type(uint256).max);

        vm.prank(owner);
        roundId =
            market.openRound(uint64(block.timestamp + 1), uint64(block.timestamp + 100), uint64(block.timestamp + 200));

        vm.warp(block.timestamp + 2);
        market.takePosition(roundId, ParimutuelRound.Side.Up, 100e18);
        vm.prank(loser);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 100e18);

        vm.warp(block.timestamp + 100);
        market.lockRound(roundId);

        // A real feed only changes price by publishing a new round, so the
        // mock does both — which gives round 2 for the close.
        MockRoundOracle(address(market.oracle())).setPrice(2100e8);
        vm.warp(block.timestamp + 100);
        market.resolveRound(roundId, 2);
    }
}
