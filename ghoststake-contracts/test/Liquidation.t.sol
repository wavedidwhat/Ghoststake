// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { CollateralVault, ILienSource } from "../src/CollateralVault.sol";
import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";

/// @notice GHO-9: anyone can clear part of an underwater position's lien and
/// take its collateral at a discount.
///
/// Positions are driven underwater the way they actually would be — by
/// letting interest accrue at high utilization — rather than by writing a
/// health factor into storage. That keeps the setup honest about what makes
/// a position liquidatable in production.
contract LiquidationTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant MAX_LTV = 5e17; // 50%
    uint256 internal constant LIQ_THRESHOLD = 65e16; // 65%
    uint256 internal constant LIQ_BONUS = 5e16; // 5%
    uint256 internal constant CLOSE_FACTOR = 5e17; // 50%
    uint256 internal constant FULL_LIQ_THRESHOLD = 6825e14; // derived: 0.65 x 1.05
    uint256 internal constant FIVE_PERCENT_APR = uint256(5e16) / YEAR;

    BorrowLiquidityPool internal pool;
    CollateralVault internal vault;
    ERC20Mock internal token;

    address internal owner = makeAddr("owner");
    address internal lender = makeAddr("lender");
    address internal alice = makeAddr("alice"); // the borrower who goes under
    address internal whale = makeAddr("whale"); // drives utilization up
    address internal keeper = makeAddr("keeper"); // the liquidator

    function setUp() public {
        token = new ERC20Mock();

        pool = new BorrowLiquidityPool(
            IERC20(address(token)), 0, uint256(4e16) / YEAR, uint256(75e16) / YEAR, 8e17, 1e17, owner
        );

        vault = new CollateralVault(IERC20(address(token)), FIVE_PERCENT_APR, ILienSource(address(pool)), _risk());

        vm.prank(owner);
        pool.setBorrowModule(address(vault));

        address[4] memory users = [alice, whale, lender, keeper];
        for (uint256 i = 0; i < users.length; i++) {
            token.mint(users[i], 5_000_000 ether);
            vm.startPrank(users[i]);
            token.approve(address(vault), type(uint256).max);
            token.approve(address(pool), type(uint256).max);
            vm.stopPrank();
        }

        vm.prank(lender);
        pool.supply(500_000 ether);
    }

    function _risk() internal pure returns (CollateralVault.RiskParams memory) {
        return CollateralVault.RiskParams({
            maxLTV: MAX_LTV,
            liquidationThreshold: LIQ_THRESHOLD,
            liquidationBonus: LIQ_BONUS,
            closeFactor: CLOSE_FACTOR
        });
    }

    function _deposit(address user, uint256 amount) internal {
        vm.prank(user);
        vault.deposit(amount, user);
    }

    function _borrow(address user, uint256 amount) internal {
        vm.prank(user);
        vault.borrow(amount);
    }

    /// @dev Puts alice underwater the honest way: borrow at the ceiling, then
    /// let interest run at high utilization until the lien overtakes the
    /// liquidation line.
    function _driveAliceUnderwater(uint256 yearsElapsed) internal {
        _deposit(alice, 1_000 ether);
        uint256 ceiling = vault.maxBorrowable(alice);
        _borrow(alice, ceiling);

        _deposit(whale, 1_000_000 ether);
        _borrow(whale, 450_000 ether); // ~90% utilization

        vm.warp(block.timestamp + yearsElapsed * 365 days);
        pool.accrue();
    }

    /// @dev Stops the moment alice crosses the line, so her health factor
    /// sits just below 1 — above `fullLiquidationThreshold`, where the close
    /// factor still applies.
    function _driveAliceJustUnderwater() internal {
        _deposit(alice, 1_000 ether);
        uint256 ceiling = vault.maxBorrowable(alice);
        _borrow(alice, ceiling);

        _deposit(whale, 1_000_000 ether);
        _borrow(whale, 450_000 ether);

        for (uint256 i = 0; i < 40; i++) {
            vm.warp(block.timestamp + 15 days);
            pool.accrue();
            if (vault.isLiquidatable(alice)) break;
        }
        require(vault.isLiquidatable(alice), "setup: alice never went under");
        require(vault.healthFactor(alice) >= FULL_LIQ_THRESHOLD, "setup: overshot past the threshold");
    }

    // ---------------------------------------------------------------
    // Gating
    // ---------------------------------------------------------------

    function test_healthyPositionCannotBeLiquidated() public {
        _deposit(alice, 1_000 ether);
        _borrow(alice, 400 ether);

        assertFalse(vault.isLiquidatable(alice));
        uint256 hf = vault.healthFactor(alice);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.PositionNotLiquidatable.selector, alice, hf));
        vault.liquidate(alice, 100 ether);
    }

    function test_positionWithNoLienCannotBeLiquidated() public {
        _deposit(alice, 1_000 ether);
        assertFalse(vault.isLiquidatable(alice));
        assertEq(vault.maxLiquidatableDebt(alice), 0);
    }

    function test_positionBecomesLiquidatableOnceHealthFactorDropsBelowOne() public {
        _driveAliceUnderwater(2);

        assertLt(vault.healthFactor(alice), WAD);
        assertTrue(vault.isLiquidatable(alice));
        assertGt(vault.maxLiquidatableDebt(alice), 0);
    }

    // ---------------------------------------------------------------
    // The liquidation itself
    // ---------------------------------------------------------------

    function test_liquidatorClearsDebtAndIsPaidABonus() public {
        _driveAliceUnderwater(2);

        uint256 repay = vault.maxLiquidatableDebt(alice);
        uint256 keeperBefore = token.balanceOf(keeper);
        uint256 lienBefore = vault.lienOf(alice);

        vm.prank(keeper);
        vault.liquidate(alice, repay);

        // Keeper paid `repay` and received `repay * 1.05`, so nets the bonus.
        assertEq(
            token.balanceOf(keeper), keeperBefore + Math.mulDiv(repay, LIQ_BONUS, WAD), "keeper nets exactly the bonus"
        );
        assertApproxEqAbs(vault.lienOf(alice), lienBefore - repay, 1e12, "lien reduced by what was repaid");
    }

    function test_liquidationImprovesTheHealthFactor() public {
        _driveAliceUnderwater(2);

        uint256 hfBefore = vault.healthFactor(alice);
        uint256 repay = vault.maxLiquidatableDebt(alice);

        vm.prank(keeper);
        vault.liquidate(alice, repay);

        assertGt(vault.healthFactor(alice), hfBefore, "liquidation must move the position toward safety");
    }

    function test_borrowerKeepsTheRemainingCollateral() public {
        _driveAliceUnderwater(2);

        uint256 sharesBefore = vault.balanceOf(alice);
        uint256 repay = vault.maxLiquidatableDebt(alice);

        vm.prank(keeper);
        vault.liquidate(alice, repay);

        assertGt(vault.balanceOf(alice), 0, "partial liquidation leaves the borrower a position");
        assertLt(vault.balanceOf(alice), sharesBefore, "but less of one");
    }

    function test_maxSentinelClearsTheCloseFactorAmount() public {
        _driveAliceUnderwater(2);
        uint256 lienBefore = vault.lienOf(alice);
        uint256 expected = vault.maxLiquidatableDebt(alice);
        assertGt(expected, 0);

        vm.prank(keeper);
        vault.liquidate(alice, type(uint256).max);

        assertApproxEqAbs(vault.lienOf(alice), lienBefore - expected, 1e12, "max sentinel clears exactly the cap");
    }

    // ---------------------------------------------------------------
    // Close factor
    // ---------------------------------------------------------------

    /// @dev The close factor is what stops one dip wiping a whole position.
    function test_closeFactorCapsASingleLiquidation() public {
        _driveAliceJustUnderwater();

        uint256 lien = vault.lienOf(alice);
        uint256 maxRepay = vault.maxLiquidatableDebt(alice);
        assertApproxEqRel(maxRepay, lien / 2, 0.001e18, "50% close factor");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.ExceedsCloseFactor.selector, maxRepay + 1, maxRepay));
        vault.liquidate(alice, maxRepay + 1);
    }

    function test_repeatedLiquidationsCanFullyUnwindAPosition() public {
        _driveAliceUnderwater(2);

        uint256 rounds;
        while (vault.isLiquidatable(alice) && rounds < 20) {
            uint256 repay = vault.maxLiquidatableDebt(alice);
            if (repay == 0) break;
            vm.prank(keeper);
            vault.liquidate(alice, repay);
            rounds++;
        }

        assertFalse(vault.isLiquidatable(alice), "position can always be brought back over the line");
        assertGt(rounds, 0);
    }

    // ---------------------------------------------------------------
    // Permissionlessness
    // ---------------------------------------------------------------

    /// @dev A permissioned liquidator is a centralisation point and a single
    /// point of failure. Anyone must be able to do this.
    function test_anyAddressCanLiquidate() public {
        _driveAliceUnderwater(2);
        address stranger = makeAddr("stranger");
        token.mint(stranger, 1_000_000 ether);
        vm.prank(stranger);
        token.approve(address(vault), type(uint256).max);

        uint256 repay = vault.maxLiquidatableDebt(alice);
        vm.prank(stranger);
        vault.liquidate(alice, repay);

        assertLt(vault.lienOf(alice), type(uint256).max);
    }

    function test_borrowerCanLiquidateThemselves() public {
        _driveAliceUnderwater(2);
        uint256 repay = vault.maxLiquidatableDebt(alice);

        // Odd but harmless: it is just repaying at a self-funded discount.
        vm.prank(alice);
        vault.liquidate(alice, repay);

        assertGt(vault.healthFactor(alice), 0);
    }

    // ---------------------------------------------------------------
    // Deep underwater / bad debt
    // ---------------------------------------------------------------

    /// @dev Once the bonus can no longer be paid in full, seizing what exists
    /// beats leaving the position untouched. The shortfall is bad debt and
    /// must not silently revert the whole path.
    /// @dev Deep enough underwater, the collateral cannot cover the bonus —
    /// so the liquidator pays more than they seize and is net NEGATIVE on the
    /// trade. Nobody rational does this, which is precisely why bad debt needs
    /// a backstop (a reserve draw, or the protocol eating it) rather than an
    /// assumption that liquidators will always show up. Recorded here so the
    /// limitation is visible rather than discovered in production.
    function test_deeplyUnderwaterLiquidationIsUnprofitable() public {
        _driveAliceUnderwater(6);

        uint256 collateral = vault.convertToAssets(vault.balanceOf(alice));
        uint256 repay = vault.maxLiquidatableDebt(alice);
        assertGt(repay, 0);
        assertLt(collateral, repay, "collateral no longer covers even the principal repaid");

        uint256 keeperBefore = token.balanceOf(keeper);
        vm.prank(keeper);
        vault.liquidate(alice, repay);

        assertLt(token.balanceOf(keeper), keeperBefore, "liquidator is out of pocket at this depth");
        assertEq(vault.balanceOf(alice), 0, "all remaining collateral was seized");
    }

    // ---------------------------------------------------------------
    // Properties
    // ---------------------------------------------------------------

    /// @dev The honest invariant. "Liquidation always improves health" is
    /// NOT true — see test_partialLiquidationBelowTheBonusLineWorsensHealth
    /// below — but debt strictly falling is true unconditionally, and it is what
    /// stops a liquidator being paid for nothing.
    function testFuzz_liquidationAlwaysReducesDebt(uint96 repayPct, uint8 yearsUnder) public {
        _driveAliceUnderwater(bound(yearsUnder, 1, 8));

        uint256 maxRepay = vault.maxLiquidatableDebt(alice);
        vm.assume(maxRepay > 1e6);
        uint256 repay = (maxRepay * bound(repayPct, 1, 100)) / 100;
        vm.assume(repay > 0);

        uint256 lienBefore = vault.lienOf(alice);
        vm.prank(keeper);
        vault.liquidate(alice, repay);

        assertLt(vault.lienOf(alice), lienBefore, "debt must always fall");
    }

    /// @dev Health improves only while collateral still exceeds
    /// (1 + bonus) x debt. Above that line, partial liquidation works as
    /// intended.
    function testFuzz_liquidationImprovesHealthAboveTheBonusLine(uint96 repayPct) public {
        _driveAliceJustUnderwater();

        uint256 collateral = vault.convertToAssets(vault.balanceOf(alice));
        uint256 debt = vault.lienOf(alice);
        vm.assume(collateral > debt + Math.mulDiv(debt, LIQ_BONUS, WAD));

        uint256 maxRepay = vault.maxLiquidatableDebt(alice);
        vm.assume(maxRepay > 1e6);
        uint256 repay = (maxRepay * bound(repayPct, 1, 100)) / 100;
        vm.assume(repay > 0);

        uint256 hfBefore = vault.healthFactor(alice);
        vm.prank(keeper);
        vault.liquidate(alice, repay);

        assertGe(vault.healthFactor(alice), hfBefore, "above the bonus line, liquidation helps");
    }

    function testFuzz_liquidatorNeverProfitsWithoutClearingDebt(uint96 repayPct) public {
        _driveAliceUnderwater(2);

        uint256 maxRepay = vault.maxLiquidatableDebt(alice);
        vm.assume(maxRepay > 1e6);
        uint256 repay = (maxRepay * bound(repayPct, 1, 100)) / 100;
        vm.assume(repay > 0);

        uint256 lienBefore = vault.lienOf(alice);
        vm.prank(keeper);
        vault.liquidate(alice, repay);

        assertLt(vault.lienOf(alice), lienBefore, "collateral only moves when debt is actually cleared");
    }

    // ---------------------------------------------------------------
    // The bonus line — where partial liquidation stops helping
    // ---------------------------------------------------------------

    /// @dev Documents the uncomfortable truth rather than hiding it. Seizing
    /// at a bonus removes proportionally more collateral than debt, so once
    /// collateral falls below (1 + bonus) x debt, a *capped* liquidation
    /// leaves the position less healthy than it started.
    ///
    /// This is exactly why `fullLiquidationThreshold` exists: below HF 0.95
    /// the cap is lifted so the position can be closed outright in one step
    /// instead of being ground down over many.
    function test_belowTheBonusLineTheCloseFactorIsLifted() public {
        _driveAliceUnderwater(4);

        uint256 collateral = vault.convertToAssets(vault.balanceOf(alice));
        uint256 debt = vault.lienOf(alice);
        assertLt(collateral, debt + Math.mulDiv(debt, LIQ_BONUS, WAD), "past the bonus line");
        assertLt(vault.healthFactor(alice), FULL_LIQ_THRESHOLD);

        // Cap lifted: the whole lien is clearable in one call.
        assertEq(vault.maxLiquidatableDebt(alice), debt, "close factor lifted to 100%");
    }

    /// @dev With the cap lifted, one liquidation ends the position instead of
    /// leaving a degraded remainder to grind at.
    function test_deeplyUnderwaterPositionClosesInOneStep() public {
        _driveAliceUnderwater(4);

        uint256 repay = vault.maxLiquidatableDebt(alice);
        vm.prank(keeper);
        vault.liquidate(alice, repay);

        assertEq(vault.lienOf(alice), 0, "lien fully cleared in a single liquidation");
        assertFalse(vault.isLiquidatable(alice), "nothing left to liquidate");
    }

    /// @dev Above the threshold the cap still applies — the lift is targeted,
    /// not a blanket removal of borrower protection.
    function test_closeFactorStillCapsNearTheLine() public {
        _driveAliceJustUnderwater();

        assertApproxEqRel(vault.maxLiquidatableDebt(alice), vault.lienOf(alice) / 2, 0.001e18, "cap intact");
    }

    // ---------------------------------------------------------------
    // The derived full-liquidation threshold (audit finding)
    // ---------------------------------------------------------------

    /// @dev The threshold is derived, not configured: it is exactly
    /// `liquidationThreshold x (1 + bonus)`, the point below which seizing at
    /// a bonus stops improving a position.
    function test_fullLiquidationThresholdIsDerivedFromBonusAndThreshold() public view {
        assertEq(
            vault.fullLiquidationThreshold(),
            Math.mulDiv(LIQ_THRESHOLD, WAD + LIQ_BONUS, WAD),
            "threshold must track the parameters it depends on"
        );
        assertEq(vault.fullLiquidationThreshold(), FULL_LIQ_THRESHOLD);
    }

    /// @dev Regression for the audit finding. A position at HF ~0.94 is
    /// rescuable by ONE capped liquidation, so the cap must still apply. The
    /// old hard-coded 0.95 lifted it to 100% here and force-closed the whole
    /// position, taking double the bonus for no protocol benefit.
    function test_positionRescuableByOneCappedLiquidationIsNotFullyClosed() public {
        _driveAliceJustUnderwater();
        uint256 hf = vault.healthFactor(alice);
        assertGt(hf, FULL_LIQ_THRESHOLD, "above the derived line");

        uint256 lien = vault.lienOf(alice);
        assertApproxEqRel(vault.maxLiquidatableDebt(alice), lien / 2, 0.001e18, "cap still applies");

        uint256 repay = vault.maxLiquidatableDebt(alice);
        vm.prank(keeper);
        vault.liquidate(alice, repay);

        assertGt(vault.lienOf(alice), 0, "borrower keeps a loan rather than being force-closed");
        assertFalse(vault.isLiquidatable(alice), "one capped liquidation restored health");
    }

    /// @dev Documents the region the derived threshold exists for: below the
    /// bonus line a *capped* liquidation genuinely makes things worse, which
    /// is why the cap is lifted there and only there.
    function test_partialLiquidationBelowTheBonusLineWorsensHealth() public {
        _driveAliceUnderwater(4);
        assertLt(vault.healthFactor(alice), FULL_LIQ_THRESHOLD, "below the bonus line");

        uint256 hfBefore = vault.healthFactor(alice);
        uint256 lien = vault.lienOf(alice);

        // Deliberately take only a capped-size bite, which the lift permits
        // but does not force, to show why finishing the job is the right move.
        vm.prank(keeper);
        vault.liquidate(alice, lien / 2);

        assertLt(vault.healthFactor(alice), hfBefore, "a partial bite down here moves the wrong way");
    }
}
