// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CollateralVault, ILienSource } from "../src/CollateralVault.sol";
import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";

/// @notice GHO-26: exiting with an open lien settles it out of the collateral
/// instead of blocking forever.
///
/// These run against a real `BorrowLiquidityPool` rather than a mock, so the
/// lien carries genuine accrued interest from the borrow index. The vault
/// reads the lien through `lienOf` — there is no second debt ledger to drift.
contract LienSettlementTest is Test {
    uint256 internal constant MAX_LTV = 5e17; // 50%
    uint256 internal constant LIQ_THRESHOLD = 65e16; // 65%
    uint256 internal constant LIQ_BONUS = 5e16; // 5%
    uint256 internal constant CLOSE_FACTOR = 5e17; // 50%
    uint256 internal constant FULL_LIQ_THRESHOLD = 95e16; // HF 0.95

    uint256 internal constant YEAR = 365 days;
    uint256 internal constant FIVE_PERCENT_APR = uint256(5e16) / YEAR;

    BorrowLiquidityPool internal pool;
    CollateralVault internal vault;
    ERC20Mock internal token;

    address internal owner = makeAddr("owner");
    address internal lender = makeAddr("lender");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new ERC20Mock();

        pool = new BorrowLiquidityPool(
            IERC20(address(token)),
            0, // base
            uint256(4e16) / YEAR, // slope1
            uint256(75e16) / YEAR, // slope2
            8e17, // kink
            1e17, // reserve factor
            owner
        );

        vault = new CollateralVault(IERC20(address(token)), FIVE_PERCENT_APR, ILienSource(address(pool)), _risk());

        // This test contract stands in for GHO-8's borrow module.
        vm.prank(owner);
        pool.setBorrowModule(address(this));

        address[3] memory users = [alice, bob, lender];
        for (uint256 i = 0; i < users.length; i++) {
            token.mint(users[i], 1_000_000 ether);
            vm.startPrank(users[i]);
            token.approve(address(vault), type(uint256).max);
            token.approve(address(pool), type(uint256).max);
            vm.stopPrank();
        }

        // Seed lending liquidity so there is something to borrow.
        vm.prank(lender);
        pool.supply(500_000 ether);
    }

    /// @dev Opens a real lien against `user` by drawing from the pool.
    function _openLien(address user, uint256 amount) internal {
        pool.borrow(amount, user);
    }

    function _shares(address user) internal view returns (uint256) {
        return vault.balanceOf(user);
    }

    // ---------------------------------------------------------------
    // The behaviour change
    // ---------------------------------------------------------------

    function test_exitWithOpenLienSettlesItAndReturnsTheRemainder() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        _openLien(alice, 300 ether);

        assertEq(vault.lienOf(alice), 300 ether, "lien reads through to the pool");

        uint256 walletBefore = token.balanceOf(alice);
        uint256 assets = vault.maxWithdraw(alice);
        uint256 shares = _shares(alice);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true, address(vault));
        emit CollateralVault.LienSettledAtExit(alice, 300 ether, assets - 300 ether);
        vault.redeem(shares, alice, alice);

        assertEq(vault.lienOf(alice), 0, "lien cleared");
        assertEq(token.balanceOf(alice) - walletBefore, assets - 300 ether, "user keeps collateral minus the lien");
        assertEq(_shares(alice), 0);
    }

    /// @dev The whole point of GHO-26: the old contract reverted here and the
    /// borrower could never leave.
    function test_borrowerIsNeverTrappedByAnOpenLien() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        _openLien(alice, 400 ether);

        vm.warp(block.timestamp + 180 days); // interest accrues on the lien

        uint256 shares = _shares(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice); // must not revert

        assertEq(_shares(alice), 0);
        assertEq(vault.lienOf(alice), 0);
    }

    function test_settlementCoversInterestAccruedSinceTheBorrow() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        _openLien(alice, 400 ether);

        vm.warp(block.timestamp + 365 days);
        pool.accrue();

        uint256 lienWithInterest = vault.lienOf(alice);
        assertGt(lienWithInterest, 400 ether, "interest actually accrued");

        uint256 walletBefore = token.balanceOf(alice);
        uint256 assets = vault.maxWithdraw(alice);
        uint256 shares = _shares(alice);

        vm.prank(alice);
        vault.redeem(shares, alice, alice);

        assertEq(vault.lienOf(alice), 0, "full lien including interest is cleared");
        assertApproxEqAbs(
            token.balanceOf(alice) - walletBefore,
            assets - lienWithInterest,
            1e12,
            "remainder is collateral minus lien-with-interest"
        );
    }

    function test_poolActuallyReceivesTheRepayment() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        _openLien(alice, 300 ether);

        uint256 poolBefore = token.balanceOf(address(pool));
        uint256 shares = _shares(alice);

        vm.prank(alice);
        vault.redeem(shares, alice, alice);

        assertEq(token.balanceOf(address(pool)) - poolBefore, 300 ether, "creditor was really paid");
        assertEq(pool.balanceOfDebt(alice), 0);
    }

    // ---------------------------------------------------------------
    // Constraints while a lien is open
    // ---------------------------------------------------------------

    function test_partialWithdrawIsRejectedWhileALienIsOpen() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        _openLien(alice, 300 ether);

        uint256 held = _shares(alice);
        uint256 half = held / 2;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.PartialExitWithLienOpen.selector, half, held));
        vault.redeem(half, alice, alice);
    }

    function test_partialWithdrawIsFineOnceTheLienIsRepaidDirectly() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        _openLien(alice, 300 ether);

        // Repaying the creditor directly is always available as an exit.
        vm.prank(alice);
        pool.repay(300 ether, alice);
        assertEq(vault.lienOf(alice), 0);

        vm.prank(alice);
        vault.withdraw(400 ether, alice, alice); // partial now allowed
        assertGt(_shares(alice), 0);
    }

    /// @dev An underwater position is the liquidation path's problem (GHO-9),
    /// not something exit should quietly socialise.
    function test_exitRevertsWhenCollateralCannotCoverTheLien() public {
        vm.prank(alice);
        vault.deposit(100 ether, alice);
        _openLien(alice, 90 ether);

        // Drive utilization past the kink so the lien compounds fast enough
        // to overtake the collateral, which does not grow (nothing funds the
        // vault's yield). At ~90% utilization the borrow rate is ~41% APR.
        _openLien(bob, 449_000 ether);

        vm.warp(block.timestamp + 3 * 365 days);
        pool.accrue();

        uint256 assets = vault.maxWithdraw(alice);
        uint256 lien = vault.lienOf(alice);
        assertGt(lien, assets, "position is genuinely underwater");

        uint256 shares = _shares(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.CollateralBelowLien.selector, alice, assets, lien));
        vault.redeem(shares, alice, alice);
    }

    // ---------------------------------------------------------------
    // The transfer asymmetry
    // ---------------------------------------------------------------

    /// @dev Exiting settles the lien; transferring would move the collateral
    /// away from the debt and strand the lien on an empty account. So exit is
    /// allowed and transfer is not — deliberately asymmetric.
    function test_transferStaysBlockedWhileALienIsOpen() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        _openLien(alice, 300 ether);

        uint256 shares = _shares(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.LienOutstanding.selector, alice, 300 ether));
        vault.transfer(bob, shares);
    }

    function test_transferWorksAgainOnceTheLienIsCleared() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        _openLien(alice, 300 ether);

        vm.prank(alice);
        pool.repay(300 ether, alice);

        uint256 shares = _shares(alice);
        vm.prank(alice);
        vault.transfer(bob, shares);
        assertEq(_shares(bob), shares);
    }

    // ---------------------------------------------------------------
    // Untouched behaviour
    // ---------------------------------------------------------------

    function test_lienFreePositionsExitExactlyAsBefore() public {
        uint256 walletBefore = token.balanceOf(alice);

        vm.startPrank(alice);
        uint256 shares = vault.deposit(1_000 ether, alice);
        assertEq(vault.lienOf(alice), 0);
        vault.redeem(shares, alice, alice);
        vm.stopPrank();

        assertEq(token.balanceOf(alice), walletBefore, "no lien, no haircut");
        assertEq(vault.totalLedgerValue(alice), 0, "ledger still zeroed on full exit");
    }

    function testFuzz_exitNeverLeavesLienOrLedgerBehind(uint96 collateral, uint96 lienPct, uint32 elapsed) public {
        collateral = uint96(bound(collateral, 100 ether, 100_000 ether));
        uint256 lienAmount = (uint256(collateral) * bound(lienPct, 1, 40)) / 100;
        elapsed = uint32(bound(elapsed, 0, 365 days));

        token.mint(alice, collateral);
        vm.prank(alice);
        vault.deposit(collateral, alice);
        _openLien(alice, lienAmount);

        vm.warp(block.timestamp + elapsed);
        pool.accrue();

        uint256 shares = _shares(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);

        assertEq(vault.lienOf(alice), 0, "lien must always be cleared by a full exit");
        assertEq(_shares(alice), 0);
        assertEq(vault.totalLedgerValue(alice), 0, "ledger must always be cleared too");
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
