// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CollateralVault, ILienSource } from "../src/CollateralVault.sol";

contract CollateralVaultTest is Test {
    uint256 internal constant MAX_LTV = 5e17; // 50%
    uint256 internal constant LIQ_THRESHOLD = 65e16; // 65%
    uint256 internal constant LIQ_BONUS = 5e16; // 5%
    uint256 internal constant CLOSE_FACTOR = 5e17; // 50%
    uint256 internal constant FULL_LIQ_THRESHOLD = 95e16; // HF 0.95

    CollateralVault internal vault;
    ERC20Mock internal token;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new ERC20Mock();
        // Rate 0: this file tests deposit/withdraw/debt-gate accounting in
        // isolation. Accrual math has its own coverage in YieldAccrual.t.sol.
        vault = new CollateralVault(IERC20(address(token)), 0, ILienSource(address(0)), _risk());

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

    /// @dev With no lien source wired, every position reads as lien-free and
    /// withdrawal is unconditional. Lien settlement has its own suite in
    /// LienSettlement.t.sol, against a real creditor.
    function test_withdrawIsUnconditionalWithNoLienSourceWired() public {
        assertEq(address(vault.lienSource()), address(0));

        vm.startPrank(alice);
        vault.deposit(100 ether, alice);
        assertEq(vault.lienOf(alice), 0);
        vault.withdraw(100 ether, alice, alice);
        vm.stopPrank();

        assertEq(token.balanceOf(alice), 1_000 ether);
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

    function _risk() internal pure returns (CollateralVault.RiskParams memory) {
        return CollateralVault.RiskParams({
            maxLTV: MAX_LTV,
            liquidationThreshold: LIQ_THRESHOLD,
            liquidationBonus: LIQ_BONUS,
            closeFactor: CLOSE_FACTOR,
            fullLiquidationThreshold: FULL_LIQ_THRESHOLD
        });
    }
}
