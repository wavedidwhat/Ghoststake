// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CollateralVault } from "../src/CollateralVault.sol";

/// @notice Covers GHO-7's three required cases (accrual across a state
/// change, zero elapsed time, precision at small amounts) plus the
/// no-cron/no-loop invariant: nothing but a call that touches a specific
/// user's position ever changes that position's storage.
contract YieldAccrualTest is Test {
    // 5% APR expressed as a per-second WAD rate: 5e16 (0.05e18) / 365 days.
    uint256 internal constant FIVE_PERCENT_APR = uint256(5e16) / 365 days;

    CollateralVault internal vault;
    ERC20Mock internal token;
    address internal alice = makeAddr("alice");

    function setUp() public {
        token = new ERC20Mock();
        vault = new CollateralVault(IERC20(address(token)), FIVE_PERCENT_APR);

        token.mint(alice, 1_000_000 ether);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
    }

    function test_accruedYieldIsZeroWithNoElapsedTime() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);

        // Same block, same second as the deposit that set the checkpoint.
        assertEq(vault.accruedYield(alice), 0);
    }

    function test_accruedYieldGrowsWithElapsedTimeButStorageDoesNotChangeUntilSettled() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);

        vm.warp(block.timestamp + 365 days);

        uint256 expected = (1_000 ether * FIVE_PERCENT_APR * 365 days) / vault.RATE_PRECISION();
        assertApproxEqRel(vault.accruedYield(alice), 50 ether, 0.01e18, "~5% of 1000 over a year");
        assertEq(vault.accruedYield(alice), expected, "matches the exact on-chain formula");

        // Purely a read — position storage is untouched.
        (uint256 principalBefore, uint256 startTimeBefore,) = vault.positions(alice);
        vault.accruedYield(alice);
        (uint256 principalAfter, uint256 startTimeAfter,) = vault.positions(alice);
        assertEq(principalBefore, principalAfter);
        assertEq(startTimeBefore, startTimeAfter);
    }

    function test_accrualIsFoldedIntoPrincipalOnStateChangeDeposit() public {
        vm.startPrank(alice);
        vault.deposit(1_000 ether, alice);
        vm.warp(block.timestamp + 365 days);

        uint256 pendingYield = vault.accruedYield(alice);
        assertGt(pendingYield, 0);

        vm.expectEmit(true, false, false, true, address(vault));
        emit CollateralVault.YieldSettled(alice, pendingYield, 1_000 ether + pendingYield);
        vault.deposit(1 ether, alice);
        vm.stopPrank();

        (uint256 principal, uint256 startTime,) = vault.positions(alice);
        assertEq(principal, 1_000 ether + pendingYield + 1 ether, "old principal + settled yield + new deposit");
        assertEq(startTime, block.timestamp, "checkpoint reset to now");
        assertEq(vault.accruedYield(alice), 0, "nothing left unsettled right after settling");
    }

    function test_accrualIsFoldedIntoPrincipalOnStateChangeWithdraw() public {
        vm.startPrank(alice);
        vault.deposit(1_000 ether, alice);
        vm.warp(block.timestamp + 365 days);
        uint256 pendingYield = vault.accruedYield(alice);

        vault.withdraw(100 ether, alice, alice);
        vm.stopPrank();

        (uint256 principal,,) = vault.positions(alice);
        assertEq(principal, 1_000 ether + pendingYield - 100 ether);
    }

    function test_explicitSettleFoldsYieldWithoutMovingFunds() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        vm.warp(block.timestamp + 30 days);
        uint256 pendingYield = vault.accruedYield(alice);
        assertGt(pendingYield, 0);

        uint256 vaultTokenBalanceBefore = token.balanceOf(address(vault));
        vault.settle(alice);

        (uint256 principal,,) = vault.positions(alice);
        assertEq(principal, 1_000 ether + pendingYield);
        assertEq(token.balanceOf(address(vault)), vaultTokenBalanceBefore, "settle never moves tokens");
    }

    function test_settleTwiceInSameSecondIsANoOpTheSecondTime() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        vm.warp(block.timestamp + 30 days);

        vault.settle(alice);
        (uint256 principalAfterFirst,,) = vault.positions(alice);

        vault.settle(alice);
        (uint256 principalAfterSecond,,) = vault.positions(alice);

        assertEq(principalAfterFirst, principalAfterSecond, "no elapsed time since the first settle => no yield added");
    }

    /// @dev Precision at small amounts: a small enough principal over a
    /// short enough window rounds down to exactly zero (expected — WAD
    /// integer division, not a bug), but the same principal held long
    /// enough eventually accrues something nonzero. Nothing reverts either
    /// way.
    function test_precisionAtSmallAmounts() public {
        vm.startPrank(alice);
        vault.deposit(1 wei, alice);

        vm.warp(block.timestamp + 1);
        assertEq(vault.accruedYield(alice), 0, "1 wei principal over 1 second rounds down to zero");

        vm.warp(block.timestamp + 365 days * 1000);
        assertGt(vault.accruedYield(alice), 0, "eventually accrues something given enough elapsed time");
        vm.stopPrank();
    }

    function testFuzz_accrualFormulaMatchesDirectComputation(uint96 principal, uint32 elapsed, uint32 rateSeed)
        public
    {
        vm.assume(principal > 0);
        uint256 rate = uint256(rateSeed) % 1e12; // keep well under overflow range for the multiply below

        CollateralVault v = new CollateralVault(IERC20(address(token)), rate);
        token.mint(alice, principal);
        vm.startPrank(alice);
        token.approve(address(v), principal);
        v.deposit(principal, alice);
        vm.stopPrank();

        vm.warp(block.timestamp + elapsed);

        uint256 expected = (uint256(principal) * rate * elapsed) / v.RATE_PRECISION();
        assertEq(v.accruedYield(alice), expected);
    }

    function testFuzz_settlingNeverChangesAnotherUsersPosition(uint96 aliceDeposit, uint96 bobDeposit) public {
        vm.assume(aliceDeposit > 0 && bobDeposit > 0);
        address bob = makeAddr("bob");
        token.mint(alice, aliceDeposit);
        token.mint(bob, bobDeposit);

        vm.prank(alice);
        token.approve(address(vault), aliceDeposit);
        vm.prank(bob);
        token.approve(address(vault), bobDeposit);

        vm.prank(alice);
        vault.deposit(aliceDeposit, alice);
        vm.prank(bob);
        vault.deposit(bobDeposit, bob);

        vm.warp(block.timestamp + 90 days);

        (uint256 bobPrincipalBefore,,) = vault.positions(bob);
        vault.settle(alice);
        (uint256 bobPrincipalAfter,,) = vault.positions(bob);

        assertEq(bobPrincipalBefore, bobPrincipalAfter, "settling alice must not touch bob's storage");
    }
}
