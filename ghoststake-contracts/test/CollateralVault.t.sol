// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { StdStorage, stdStorage } from "forge-std/StdStorage.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CollateralVault } from "../src/CollateralVault.sol";

contract CollateralVaultTest is Test {
    using stdStorage for StdStorage;

    CollateralVault internal vault;
    ERC20Mock internal token;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new ERC20Mock();
        // Rate 0: this file tests deposit/withdraw/debt-gate accounting in
        // isolation. Accrual math has its own coverage in YieldAccrual.t.sol.
        vault = new CollateralVault(IERC20(address(token)), 0);

        token.mint(alice, 1_000 ether);
        token.mint(bob, 1_000 ether);

        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);
    }

    function test_depositMintsSharesAndTracksPrincipal() public {
        vm.warp(1_000);
        vm.prank(alice);
        vm.expectEmit(true, false, false, true, address(vault));
        emit CollateralVault.Deposited(alice, 100 ether, 100 ether * 10 ** 6);
        uint256 shares = vault.deposit(100 ether, alice);

        assertEq(shares, 100 ether * 10 ** 6, "1:1 exchange rate before any yield/loss");
        assertEq(vault.balanceOf(alice), shares);
        assertEq(token.balanceOf(address(vault)), 100 ether);

        (uint256 principal, uint256 startTime,,) = vault.positions(alice);
        assertEq(principal, 100 ether);
        assertEq(startTime, 1_000);
    }

    function test_secondDepositAccumulatesPrincipalAndBumpsTimestamp() public {
        vm.warp(1_000);
        vm.prank(alice);
        vault.deposit(100 ether, alice);

        vm.warp(2_000);
        vm.prank(alice);
        vault.deposit(50 ether, alice);

        (uint256 principal, uint256 startTime,,) = vault.positions(alice);
        assertEq(principal, 150 ether);
        assertEq(startTime, 2_000);
    }

    function test_withdrawReturnsAssetsAndReducesPrincipal() public {
        vm.startPrank(alice);
        vault.deposit(100 ether, alice);

        vm.expectEmit(true, false, false, true, address(vault));
        emit CollateralVault.Withdrawn(alice, 40 ether, 40 ether * 10 ** 6);
        vault.withdraw(40 ether, alice, alice);
        vm.stopPrank();

        assertEq(token.balanceOf(alice), 1_000 ether - 60 ether);
        (uint256 principal,,,) = vault.positions(alice);
        assertEq(principal, 60 ether);
    }

    function test_fullWithdrawZeroesPrincipalWithoutUnderflow() public {
        vm.startPrank(alice);
        vault.deposit(100 ether, alice);
        vault.withdraw(100 ether, alice, alice);
        vm.stopPrank();

        (uint256 principal,,,) = vault.positions(alice);
        assertEq(principal, 0);
    }

    function test_redeemGoesThroughSameAccountingAsWithdraw() public {
        vm.startPrank(alice);
        uint256 shares = vault.deposit(100 ether, alice);
        vault.redeem(shares, alice, alice);
        vm.stopPrank();

        (uint256 principal,,,) = vault.positions(alice);
        assertEq(principal, 0);
        assertEq(token.balanceOf(alice), 1_000 ether);
    }

    function test_withdrawRevertsWhileDebtOutstanding() public {
        vm.prank(alice);
        vault.deposit(100 ether, alice);

        // No borrow module yet (GHO-8) — simulate outstanding debt directly
        // against the stubbed `debtOf` mapping via its storage slot.
        stdstore.target(address(vault)).sig("debtOf(address)").with_key(alice).checked_write(1 ether);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.DebtOutstanding.selector, alice, 1 ether));
        vault.withdraw(50 ether, alice, alice);
    }

    function test_redeemAlsoRevertsWhileDebtOutstanding() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(100 ether, alice);

        stdstore.target(address(vault)).sig("debtOf(address)").with_key(alice).checked_write(1 ether);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.DebtOutstanding.selector, alice, 1 ether));
        vault.redeem(shares, alice, alice);
    }

    function test_depositDoesNotAffectOtherUsersPosition() public {
        vm.prank(alice);
        vault.deposit(100 ether, alice);
        vm.prank(bob);
        vault.deposit(30 ether, bob);

        (uint256 alicePrincipal,,,) = vault.positions(alice);
        (uint256 bobPrincipal,,,) = vault.positions(bob);
        assertEq(alicePrincipal, 100 ether);
        assertEq(bobPrincipal, 30 ether);
    }

    function testFuzz_depositWithdrawRoundTripReturnsPrincipal(uint96 amount) public {
        vm.assume(amount > 0);
        token.mint(alice, amount);

        vm.startPrank(alice);
        token.approve(address(vault), amount);
        uint256 balanceBefore = token.balanceOf(alice);

        uint256 shares = vault.deposit(amount, alice);
        vault.redeem(shares, alice, alice);
        vm.stopPrank();

        assertEq(token.balanceOf(alice), balanceBefore, "full round trip returns exactly what was put in");
    }
}
