// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AttackHarness } from "./AttackHarness.sol";
import { CollateralVault } from "../../src/CollateralVault.sol";

/// @notice Not a suite of defences — a suite of *demonstrations*. Each test
/// here reproduces a weakness that is real and currently unmitigated, and
/// pins its magnitude so the grade behind it is a measurement rather than an
/// opinion. If a future change closes one of these, the test fails and the
/// grade gets revisited.
contract ResidualRiskTest is AttackHarness {
    function setUp() public {
        _deployStack();
    }

    /// @dev X1 — BAD DEBT IS NEVER RECOGNISED. Once a position's collateral
    /// is gone but its lien is not, nobody will ever liquidate it (there is
    /// nothing left to seize), the debt stays on the pool's books, and the
    /// supply index keeps accruing interest on a loan that will never be
    /// repaid. Suppliers hold claims that quietly stop being backed.
    function test_X1_badDebtStaysOnTheBooksAndKeepsAccruing() public {
        // Size it the way a real default looks: one large borrower against
        // most of the pool, not a rounding error against a deep book.
        _fund(mallory, 2_000_000 ether);
        _deposit(mallory, 1_200_000 ether);
        _borrow(mallory, pool.availableLiquidity()); // 500k, inside the 600k LTV ceiling

        // Run interest until the position is far enough underwater that the
        // close-factor cap lifts and one liquidation can take everything.
        while (vault.healthFactor(mallory) >= vault.fullLiquidationThreshold()) {
            vm.warp(block.timestamp + 90 days);
            pool.accrue();
        }

        uint256 collateral = vault.convertToAssets(vault.balanceOf(mallory));
        // The only trade a rational liquidator makes: repay exactly what the
        // collateral plus bonus covers, and leave the rest as someone else's
        // problem.
        uint256 rationalRepay = collateral * WAD / (WAD + LIQ_BONUS);
        _fund(alice, 5_000_000 ether);
        vm.prank(alice);
        vault.liquidate(mallory, rationalRepay);

        uint256 orphaned = vault.lienOf(mallory);
        assertGt(orphaned, 0, "debt survives with no collateral behind it");
        assertLe(vault.convertToAssets(vault.balanceOf(mallory)), 1, "and nothing left to seize but dust");

        // Nobody rational touches it again — repaying more buys nothing — and
        // the pool goes on counting it as a performing loan. There is no
        // writedown, so supplier claims are never reduced to match.
        uint256 claims = pool.totalSupplied();
        uint256 collectable = pool.availableLiquidity() + pool.totalBorrowed() - orphaned;
        assertGt(claims, collectable, "supplier claims exceed everything that could ever be collected");

        emit log_named_uint("orphaned bad debt (wei)", orphaned);
        emit log_named_uint("supplier claims (wei)", claims);
        emit log_named_uint("collectable (wei)", collectable);
        emit log_named_uint("SHORTFALL (wei)", claims - collectable);
    }

    /// @dev X2 — LAST SUPPLIER OUT LOSES. There is no bad-debt writedown, so
    /// the shortfall is not shared: suppliers are paid in the order they
    /// withdraw, and whoever is last finds the cash gone.
    function test_X2_shortfallIsFirstComeFirstServedNotShared() public {
        vm.prank(bob);
        pool.supply(100_000 ether);

        _deposit(mallory, 400_000 ether);
        _borrow(mallory, vault.maxBorrowable(mallory));
        vm.warp(block.timestamp + 3 * YEAR);
        pool.accrue();

        // Bob exits first, at his full accrued balance.
        uint256 bobClaim = pool.balanceOfSupply(bob);
        vm.prank(bob);
        pool.withdraw(bobClaim);

        uint256 lenderClaim = pool.balanceOfSupply(lender);
        assertGt(lenderClaim, pool.availableLiquidity(), "the supplier who waits cannot get out");

        vm.expectRevert();
        vm.prank(lender);
        pool.withdraw(lenderClaim);
    }

    /// @dev X3 — LIQUIDITY LOCK AS A GRIEF. A single borrower can take every
    /// spare token in the pool and hold it, which freezes every supplier's
    /// exit for as long as they are willing to pay interest.
    function test_X3_oneBorrowerCanFreezeEverySupplierExit() public {
        _fund(mallory, 2_000_000 ether);
        _deposit(mallory, 2_500_000 ether);

        _borrow(mallory, pool.availableLiquidity());
        assertEq(pool.availableLiquidity(), 0, "the pool is drained of cash");

        vm.expectRevert();
        vm.prank(lender);
        pool.withdraw(1 ether);
    }
}
