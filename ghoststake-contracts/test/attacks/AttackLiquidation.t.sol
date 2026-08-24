// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { AttackHarness } from "./AttackHarness.sol";
import { CollateralVault } from "../../src/CollateralVault.sol";

/// @notice Adversarial suite against the liquidation engine and the lending
/// pool's accounting. The economic attacks here follow the "toxic liquidation
/// spiral" literature (arXiv 2212.07306) and the Decurity CDP taxonomy:
/// self-liquidation for profit, liquidating a healthy position, grinding a
/// position downward with capped liquidations, and draining the pool through
/// rounding.
contract AttackLiquidationTest is AttackHarness {
    function setUp() public {
        _deployStack();
    }

    /// @dev Puts `user` under the liquidation line by letting interest run,
    /// which is the only lever available when collateral and debt are the
    /// same asset and no oracle sits between them.
    function _pushUnderwater(address user, uint256 deposited) internal {
        _deposit(user, deposited);
        _borrow(user, vault.maxBorrowable(user));
        while (vault.healthFactor(user) >= WAD) {
            vm.warp(block.timestamp + 30 days);
            pool.accrue();
        }
    }

    // ================================================================
    // D. Liquidation
    // ================================================================

    /// @dev D1 — liquidate a position that is not underwater. The bonus is
    /// free money if the health check can be skipped or rounded past.
    function test_D1_healthyPositionsCannotBeLiquidated() public {
        _deposit(victim, 1_000 ether);
        _borrow(victim, 400 ether);
        assertGe(vault.healthFactor(victim), WAD, "precondition: healthy");

        vm.expectRevert();
        vm.prank(mallory);
        vault.liquidate(victim, 1 ether);
    }

    /// @dev D2 — self-liquidation. If seizing your own collateral at a
    /// discount nets out positive, every borrower farms the bonus off the
    /// suppliers.
    function test_D2_selfLiquidationIsNeverProfitable() public {
        _pushUnderwater(mallory, 1_000 ether);
        int256 before = _netWorth(mallory);

        vm.prank(mallory);
        vault.liquidate(mallory, type(uint256).max);

        assertLe(_netWorth(mallory), before, "self-liquidation must not create value for the borrower");
    }

    /// @dev D3 — the toxic spiral. Repeated capped liquidations must drive
    /// health up, never down; a cap that keeps applying below the inversion
    /// point makes every step worse and can never finish.
    function test_D3_repeatedLiquidationsConvergeRatherThanSpiral() public {
        _pushUnderwater(victim, 1_000 ether);

        uint256 previous = vault.healthFactor(victim);
        for (uint256 i = 0; i < 20; i++) {
            if (!vault.isLiquidatable(victim) || vault.maxLiquidatableDebt(victim) == 0) break;
            vm.prank(mallory);
            vault.liquidate(victim, type(uint256).max);

            uint256 current = vault.healthFactor(victim);
            // Either health improved, or the position is finished (no
            // collateral left to seize, which ends the loop).
            bool finished = vault.convertToAssets(vault.balanceOf(victim)) == 0;
            assertTrue(current >= previous || finished, "capped liquidation must not degrade the position");
            if (finished) break;
            previous = current;
        }
    }

    /// @dev D4 — seize more collateral than the debt plus bonus entitles you
    /// to, by asking for more than the close factor allows.
    function test_D4_closeFactorCannotBeExceeded() public {
        _pushUnderwater(victim, 1_000 ether);
        uint256 maxRepay = vault.maxLiquidatableDebt(victim);

        vm.expectRevert();
        vm.prank(mallory);
        vault.liquidate(victim, maxRepay + 1);
    }

    /// @dev D5 — the liquidator must never receive more collateral than the
    /// borrower actually had, and must always pay before being paid.
    function test_D5_liquidatorNeverSeizesMoreThanTheBorrowerHeld() public {
        _pushUnderwater(victim, 1_000 ether);
        uint256 collateral = vault.convertToAssets(vault.balanceOf(victim));
        uint256 walletBefore = token.balanceOf(mallory);

        vm.prank(mallory);
        vault.liquidate(victim, type(uint256).max);

        uint256 gained = token.balanceOf(mallory) - walletBefore + vault.lienOf(victim);
        assertLe(gained, collateral + 1, "seizure bounded by the collateral that existed");
    }

    /// @dev D6 — grind the liquidation bonus by calling with a dust repay
    /// amount many times. Rounding in the seizure maths is the classic way
    /// this leaks.
    function test_D6_dustLiquidationsCannotGrindOutValue() public {
        _pushUnderwater(victim, 1_000 ether);
        uint256 walletBefore = token.balanceOf(mallory);
        uint256 lienBefore = vault.lienOf(victim);

        for (uint256 i = 0; i < 200; i++) {
            if (!vault.isLiquidatable(victim)) break;
            if (vault.convertToAssets(vault.balanceOf(victim)) == 0) break;
            vm.prank(mallory);
            try vault.liquidate(victim, 1) { }
            catch {
                break;
            }
        }

        int256 spent = int256(walletBefore) - int256(token.balanceOf(mallory));
        int256 debtCleared = int256(lienBefore) - int256(vault.lienOf(victim));
        // The liquidator's gross gain is bounded by the bonus on what they
        // actually repaid; dust rounding must not beat that.
        assertLe(
            -spent, debtCleared * int256(LIQ_BONUS) / int256(WAD) + 200, "dust grinding cannot beat the stated bonus"
        );
    }

    // ================================================================
    // E. Lending pool accounting
    // ================================================================

    /// @dev E1 — the solvency invariant. Supplier claims plus protocol
    /// reserves must never exceed cash on hand plus outstanding debt.
    function testFuzz_E1_poolStaysSolventUnderArbitraryTraffic(
        uint96[8] calldata supplies,
        uint96[8] calldata borrows,
        uint32[8] calldata gaps
    ) public {
        _deposit(mallory, 500_000 ether);

        for (uint256 i = 0; i < 8; i++) {
            uint256 s = uint256(supplies[i]) % 100_000 ether;
            if (s > 0) {
                vm.prank(alice);
                pool.supply(s);
            }
            uint256 room = vault.maxBorrowable(mallory);
            uint256 b =
                bound(uint256(borrows[i]), 0, room > pool.availableLiquidity() ? pool.availableLiquidity() : room);
            if (b > 0) _borrow(mallory, b);
            vm.warp(block.timestamp + (uint256(gaps[i]) % 90 days));
            pool.accrue();
        }

        uint256 claims = pool.totalSupplied() + pool.totalReserves();
        uint256 backing = pool.availableLiquidity() + pool.totalBorrowed();
        assertLe(claims, backing + 1e12, "supplier + reserve claims must be backed by cash + debt");
    }

    /// @dev E2 — the treasury must not be able to withdraw "reserves" that
    /// are really supplier principal. Reserves are credited when interest
    /// accrues, not when a borrower actually pays.
    function test_E2_reservesAreSubordinateToSuppliers() public {
        _deposit(mallory, 500_000 ether);
        _borrow(mallory, vault.maxBorrowable(mallory));
        vm.warp(block.timestamp + 5 * YEAR);
        pool.accrue();

        assertGt(pool.totalReserves(), 0, "precondition: reserves accrued on unpaid interest");

        uint256 reserves = pool.totalReserves();
        vm.expectRevert();
        vm.prank(owner);
        pool.withdrawReserves(owner, reserves);
    }

    /// @dev E3 — mint supply out of rounding by repeating 1-wei supplies and
    /// withdrawals against a grown index.
    function test_E3_roundingCannotMintSupplyBalance() public {
        _deposit(mallory, 500_000 ether);
        _borrow(mallory, vault.maxBorrowable(mallory));
        vm.warp(block.timestamp + 3 * YEAR);
        pool.accrue();

        uint256 walletBefore = token.balanceOf(bob);
        vm.startPrank(bob);
        for (uint256 i = 0; i < 300; i++) {
            pool.supply(1);
            if (pool.balanceOfSupply(bob) > 0) {
                try pool.withdraw(pool.balanceOfSupply(bob)) { } catch { }
            }
        }
        if (pool.balanceOfSupply(bob) > 0) pool.withdraw(pool.balanceOfSupply(bob));
        vm.stopPrank();

        assertLe(token.balanceOf(bob), walletBefore, "rounding must never pay a supplier more than they put in");
    }

    /// @dev E4 — repay less than owed and have the debt cleared by rounding.
    function test_E4_roundingCannotClearDebtForFree() public {
        _deposit(mallory, 1_000 ether);
        _borrow(mallory, 400 ether);
        vm.warp(block.timestamp + 2 * YEAR);
        pool.accrue();

        uint256 debtBefore = vault.lienOf(mallory);
        uint256 paid;
        vm.startPrank(mallory);
        for (uint256 i = 0; i < 300; i++) {
            try vault.repay(1, mallory) {
                paid += 1;
            } catch {
                break;
            }
        }
        vm.stopPrank();

        uint256 cleared = debtBefore - vault.lienOf(mallory);
        assertLe(cleared, paid, "a wei of repayment can never clear more than a wei of debt");
    }

    /// @dev E5 — drain the pool by borrowing more than it holds.
    function test_E5_cannotBorrowBeyondAvailableLiquidity() public {
        _fund(mallory, 2_000_000 ether);
        _deposit(mallory, 2_500_000 ether);

        uint256 available = pool.availableLiquidity();
        uint256 room = vault.maxBorrowable(mallory);
        assertGt(room, available, "precondition: LTV room exceeds the cash in the pool");

        vm.expectRevert();
        vm.prank(mallory);
        vault.borrow(available + 1);
    }
}
