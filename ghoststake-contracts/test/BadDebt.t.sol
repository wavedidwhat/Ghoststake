// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { CollateralVault, ILienSource } from "../src/CollateralVault.sol";
import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";

/// @notice GHO-45: a shortfall now has an owner.
///
/// Liquidation pays a bonus out of collateral, so once a position owes more
/// than it holds no repayment size leaves a liquidator ahead — GHO-9's
/// `test_deeplyUnderwaterLiquidationIsUnprofitable` proves it. The position
/// then cannot be closed by anyone, and the loss behind it lands on whichever
/// supplier withdraws last.
///
/// Positions are driven under the way they actually would be, by letting
/// interest accrue at high utilization, rather than by writing a health factor
/// into storage.
contract BadDebtTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant YEAR = 365 days;

    BorrowLiquidityPool internal pool;
    CollateralVault internal vault;
    ERC20Mock internal token;

    address internal owner = makeAddr("owner");
    address internal lender = makeAddr("lender");
    address internal lender2 = makeAddr("lender2");
    address internal alice = makeAddr("alice"); // the borrower who goes under
    address internal whale = makeAddr("whale"); // drives utilization up
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        token = new ERC20Mock();
        pool = new BorrowLiquidityPool(
            IERC20(address(token)), 0, uint256(4e16) / YEAR, uint256(75e16) / YEAR, 8e17, 1e17, owner
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
            })
        );
        vm.prank(owner);
        pool.setBorrowModule(address(vault));

        address[5] memory users = [alice, whale, lender, lender2, keeper];
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

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    /// @dev Puts alice at the LTV ceiling and lets interest do the rest.
    ///
    /// The ceiling is read outside the prank on purpose: an argument is
    /// evaluated before the call it belongs to, so `vm.prank(alice)` followed
    /// by `borrow(maxBorrowable(alice))` spends the prank on the view and
    /// sends the borrow from the test contract. It cost a confusing
    /// `ExceedsMaxLTV(..., 0)` to find.
    function _driveAliceUnder(uint256 yearsElapsed) internal {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        uint256 ceiling = vault.maxBorrowable(alice);
        vm.prank(alice);
        vault.borrow(ceiling);

        vm.prank(whale);
        vault.deposit(1_000_000 ether, whale);
        vm.prank(whale);
        vault.borrow(450_000 ether); // ~90% utilization

        vm.warp(block.timestamp + yearsElapsed * YEAR);
        pool.accrue();
    }

    function _seizable(address user) internal view returns (uint256) {
        return vault.convertToAssets(vault.balanceOf(user));
    }

    /// @dev A second deployment with no reserve cut, for the tests about where
    /// a loss lands once reserves are gone.
    ///
    /// Draining the real reserves is not an option: `withdrawReserves` refuses
    /// while cash is below every supplier claim, and in these scenarios most
    /// of the cash is lent out — which is the floor doing exactly its job.
    /// Nor can the shortfall simply be grown past the reserves: reserves take
    /// a cut of interest on the *whole* pool, so with a large second borrower
    /// they outrun one position's shortfall indefinitely.
    ///
    /// Setting the cut to zero isolates the socialisation arithmetic instead
    /// of arranging for it to be reached. The ordering itself is covered on
    /// the real deployment by `test_reservesAbsorbTheLossBeforeSuppliersDo`.
    function _deployWithoutReserves() internal returns (BorrowLiquidityPool p, CollateralVault v) {
        (p, v) = _deploy(0);
        vm.prank(lender);
        p.supply(500_000 ether);
    }

    /// @dev A fresh, unsupplied deployment at a chosen reserve factor.
    function _deploy(uint256 reserveFactor_) internal returns (BorrowLiquidityPool p, CollateralVault v) {
        p = new BorrowLiquidityPool(
            IERC20(address(token)), 0, uint256(4e16) / YEAR, uint256(75e16) / YEAR, 8e17, reserveFactor_, owner
        );
        v = new CollateralVault(
            IERC20(address(token)),
            uint256(5e16) / YEAR,
            ILienSource(address(p)),
            CollateralVault.RiskParams({
                maxLTV: 5e17,
                liquidationThreshold: 65e16,
                liquidationBonus: 5e16,
                closeFactor: 5e17
            })
        );
        vm.prank(owner);
        p.setBorrowModule(address(v));

        address[5] memory users = [alice, whale, lender, lender2, keeper];
        for (uint256 i = 0; i < users.length; i++) {
            vm.startPrank(users[i]);
            token.approve(address(v), type(uint256).max);
            token.approve(address(p), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @dev The same drive, against a supplied pool and vault.
    function _driveAliceUnderOn(BorrowLiquidityPool p, CollateralVault v, uint256 yearsElapsed) internal {
        vm.prank(alice);
        v.deposit(1_000 ether, alice);
        uint256 ceiling = v.maxBorrowable(alice);
        vm.prank(alice);
        v.borrow(ceiling);

        vm.prank(whale);
        v.deposit(1_000_000 ether, whale);
        vm.prank(whale);
        v.borrow(450_000 ether);

        vm.warp(block.timestamp + yearsElapsed * YEAR);
        p.accrue();
    }

    function _seizableOn(CollateralVault v, address user) internal view returns (uint256) {
        return v.convertToAssets(v.balanceOf(user));
    }

    // ---------------------------------------------------------------
    // The precondition
    // ---------------------------------------------------------------

    /// A position a liquidator can still close at a profit is not bad debt,
    /// and writing it off would hand the borrower a discharge that `liquidate`
    /// was going to collect on.
    function test_recoverablePositionCannotBeWrittenOff() public {
        _driveAliceUnder(2);

        uint256 debt = vault.lienOf(alice);
        uint256 collateral = _seizable(alice);
        assertLe(debt, collateral, "setup: this position is still covered");

        vm.expectRevert(abi.encodeWithSelector(CollateralVault.PositionIsRecoverable.selector, alice, debt, collateral));
        vm.prank(keeper);
        vault.writeOffBadDebt(alice);
    }

    /// A healthy position with no lien at all is the same refusal, and worth
    /// its own test: `lienOf` returning zero must not read as "nothing to
    /// recover" and let anyone burn a stranger's collateral.
    function test_positionWithNoDebtCannotBeWrittenOff() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);

        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.PositionIsRecoverable.selector, alice, 0, _seizable(alice))
        );
        vm.prank(keeper);
        vault.writeOffBadDebt(alice);
    }

    // ---------------------------------------------------------------
    // The write-off
    // ---------------------------------------------------------------

    function test_writeOffSeizesEverythingAndClearsTheDebt() public {
        _driveAliceUnder(6);

        uint256 debt = vault.lienOf(alice);
        uint256 collateral = _seizable(alice);
        assertGt(debt, collateral, "setup: alice owes more than she holds");

        vm.prank(keeper);
        vault.writeOffBadDebt(alice);

        assertEq(vault.balanceOf(alice), 0, "every share seized");
        assertEq(vault.lienOf(alice), 0, "debt cleared");
        assertFalse(vault.isLiquidatable(alice), "position is closed, not merely quieter");
        assertApproxEqAbs(pool.totalBadDebt(), debt - collateral, 1, "loss recorded is the shortfall");
    }

    /// The liquidator is paid a bonus out of collateral. By this point there
    /// is none to spare, and paying one would enlarge the loss it exists to
    /// limit — so the write-off takes the collateral at par.
    function test_writeOffPaysNoBonus() public {
        _driveAliceUnder(6);

        uint256 debtBefore = vault.lienOf(alice);
        uint256 collateral = _seizable(alice);
        uint256 keeperBefore = token.balanceOf(keeper);

        vm.prank(keeper);
        vault.writeOffBadDebt(alice);

        assertEq(token.balanceOf(keeper), keeperBefore, "caller neither pays nor is paid");
        assertApproxEqAbs(pool.totalBadDebt(), debtBefore - collateral, 1, "the whole collateral went against the debt");
    }

    /// The second-order harm, and the reason the debt is cleared rather than
    /// relabelled: utilization sets the borrow rate for *everybody*, so a dead
    /// loan left on the books taxes every honest borrower.
    function test_writtenOffDebtStopsCountingTowardUtilization() public {
        _driveAliceUnder(6);

        uint256 utilBefore = pool.utilization();
        uint256 borrowedBefore = pool.totalBorrowed();

        vm.prank(keeper);
        vault.writeOffBadDebt(alice);

        assertLt(pool.totalBorrowed(), borrowedBefore, "the dead loan left the borrow book");
        assertLt(pool.utilization(), utilBefore, "and stopped setting everyone else's rate");
    }

    // ---------------------------------------------------------------
    // Where the loss lands
    // ---------------------------------------------------------------

    /// Reserves are the protocol's cut of borrower interest, and this is the
    /// risk that cut is paid for. They go first.
    function test_reservesAbsorbTheLossBeforeSuppliersDo() public {
        _driveAliceUnder(6);

        uint256 reservesBefore = pool.totalReserves();
        uint256 indexBefore = pool.supplyIndex();
        uint256 shortfall = vault.lienOf(alice) - _seizable(alice);
        assertGt(reservesBefore, shortfall, "setup: reserves can cover this one alone");

        vm.prank(keeper);
        vault.writeOffBadDebt(alice);

        assertApproxEqAbs(pool.totalReserves(), reservesBefore - shortfall, 1e12, "reserves took it");
        assertEq(pool.supplyIndex(), indexBefore, "suppliers were not touched");
    }

    /// Past the reserves, the loss is socialised by moving the supply index —
    /// which is the whole reason to do it that way: every supplier's balance
    /// becomes correct at once, with nobody needing to be touched.
    function test_lossBeyondReservesIsSocialisedAcrossSuppliers() public {
        (BorrowLiquidityPool p, CollateralVault v) = _deployWithoutReserves();
        _driveAliceUnderOn(p, v, 6);

        uint256 shortfall = v.lienOf(alice) - _seizableOn(v, alice);
        assertGt(shortfall, 0, "setup: there is a shortfall to place");
        uint256 suppliedBefore = p.totalSupplied();
        uint256 lenderBefore = p.balanceOfSupply(lender);
        uint256 indexBefore = p.supplyIndex();

        vm.prank(keeper);
        v.writeOffBadDebt(alice);

        assertLt(p.supplyIndex(), indexBefore, "the index moved down");
        assertApproxEqRel(
            p.totalSupplied(), suppliedBefore - shortfall, 1e12, "suppliers absorbed exactly the shortfall"
        );
        assertLt(p.balanceOfSupply(lender), lenderBefore, "and the lender sees it in their own balance");
    }

    /// Equally, which is the point of an index write-down over a queue: the
    /// alternative is that the loss lands entirely on whoever withdraws last.
    function test_everySupplierTakesTheSameHaircut() public {
        (BorrowLiquidityPool p, CollateralVault v) = _deployWithoutReserves();
        // Small next to the first lender's 500,000, and deliberately so. A
        // stake large enough to matter drops utilization below the kink — at
        // 250,000 the rate falls to about 3%/year and alice never crosses at
        // all, which cost a confusing `PositionIsRecoverable` to work out.
        // Unequal stakes also make the proportionality claim below stronger
        // than equal ones would.
        vm.prank(lender2);
        p.supply(5_000 ether);

        _driveAliceUnderOn(p, v, 6);

        uint256 oneBefore = p.balanceOfSupply(lender);
        uint256 twoBefore = p.balanceOfSupply(lender2);

        vm.prank(keeper);
        v.writeOffBadDebt(alice);

        uint256 oneLoss = oneBefore - p.balanceOfSupply(lender);
        uint256 twoLoss = twoBefore - p.balanceOfSupply(lender2);
        assertGt(oneLoss, 0, "setup: somebody was actually charged");

        // Proportional to holdings, not equal in absolute terms.
        assertApproxEqRel(
            Math.mulDiv(oneLoss, WAD, oneBefore),
            Math.mulDiv(twoLoss, WAD, twoBefore),
            1e12,
            "the haircut is the same percentage for both"
        );
    }

    /// An empty pool has nobody to charge. Recording it rather than reverting
    /// matters: a revert would leave the dead loan on the books forever.
    ///
    /// It is deliberately not carried forward onto the next supplier — they
    /// buy in at the current index, and the index is the only thing that
    /// remembers a loss.
    function test_lossWithNoSuppliersIsRecordedRatherThanCarriedForward() public {
        (BorrowLiquidityPool p, CollateralVault v) = _deployWithoutReserves();
        _driveAliceUnderOn(p, v, 6);

        // Everyone leaves: the whale clears their debt, then the lender exits.
        // Each argument is read before its prank, for the reason in
        // `_driveAliceUnder`.
        uint256 whaleDebt = p.balanceOfDebt(whale);
        vm.prank(whale);
        v.repay(whaleDebt, whale);

        // Even with every collectable loan repaid, the lender cannot withdraw
        // their own stated balance — the hole is already there, and this is
        // the run dynamic the whole issue is about. Donated here purely so the
        // empty-pool branch can be reached; the shortage itself is asserted in
        // `test_writeOffMakesTheSupplyBookHonest`.
        uint256 lenderBalance = p.balanceOfSupply(lender);
        vm.expectRevert();
        vm.prank(lender);
        p.withdraw(lenderBalance);
        token.mint(address(p), lenderBalance);

        vm.prank(lender);
        p.withdraw(lenderBalance);
        assertEq(p.totalSupplyScaled(), 0, "setup: no suppliers left");

        uint256 shortfall = v.lienOf(alice) - _seizableOn(v, alice);
        uint256 indexBefore = p.supplyIndex();

        vm.prank(keeper);
        v.writeOffBadDebt(alice);

        assertApproxEqAbs(p.unsocialisedBadDebt(), shortfall, 1, "recorded as unsocialised");
        assertEq(p.supplyIndex(), indexBefore, "the index is meaningless with nobody holding it");

        // The next supplier inherits nothing.
        vm.prank(lender2);
        p.supply(1_000 ether);
        assertApproxEqAbs(p.balanceOfSupply(lender2), 1_000 ether, 1, "a new deposit is whole");
    }

    // ---------------------------------------------------------------
    // Authority
    // ---------------------------------------------------------------

    /// A public `absorbBadDebt` would be a permissionless "forgive my debt".
    /// The pool has no concept of collateral, so it cannot check for itself.
    function test_onlyTheBorrowModuleCanAbsorb() public {
        _driveAliceUnder(6);

        vm.expectRevert(abi.encodeWithSelector(BorrowLiquidityPool.NotBorrowModule.selector, alice));
        vm.prank(alice);
        pool.absorbBadDebt(alice);

        vm.expectRevert(abi.encodeWithSelector(BorrowLiquidityPool.NotBorrowModule.selector, owner));
        vm.prank(owner);
        pool.absorbBadDebt(alice);
    }

    /// The write-off is open to anyone, on evidence rather than authority —
    /// the same argument `liquidate` is open on. An owner-gated version would
    /// be a switch for cancelling any borrower's debt at suppliers' expense.
    function test_anyoneMayWriteOffAProvenLoss() public {
        _driveAliceUnder(6);

        address passerby = makeAddr("passerby");
        vm.prank(passerby);
        vault.writeOffBadDebt(alice);

        assertEq(vault.lienOf(alice), 0);
    }

    // ---------------------------------------------------------------
    // Properties
    // ---------------------------------------------------------------

    /// The borrower must never come out ahead by letting this happen. They
    /// lose every unit of collateral, and repaying was always available.
    function test_borrowerGainsNothingByBeingWrittenOff() public {
        _driveAliceUnder(6);

        uint256 walletBefore = token.balanceOf(alice);
        uint256 collateral = _seizable(alice);

        vm.prank(keeper);
        vault.writeOffBadDebt(alice);

        assertEq(token.balanceOf(alice), walletBefore, "nothing was handed back");
        assertEq(vault.balanceOf(alice), 0, "and the collateral is gone");
        assertGt(collateral, 0, "setup: there was collateral to lose");
    }

    /// The regression this whole issue is about. Before the write-off the
    /// books promise suppliers more than the pool can ever produce; after it,
    /// they do not.
    function test_writeOffMakesTheSupplyBookHonest() public {
        (BorrowLiquidityPool p, CollateralVault v) = _deployWithoutReserves();
        _driveAliceUnderOn(p, v, 6);

        // The whale is repaid first, and not for tidiness. Six years at this
        // utilization puts the whale under water too — 450,000 borrowed
        // against 1,000,000 of collateral grows past it on the same curve that
        // sinks alice — so leaving that loan outstanding would mean writing
        // off one bad debt and asserting the books were clean while a second,
        // larger one stood behind it. The whale can pay, so they do.
        uint256 whaleDebt = p.balanceOfDebt(whale);
        vm.prank(whale);
        v.repay(whaleDebt, whale);

        // What the pool could actually raise: cash, plus every loan that can
        // still be collected, each capped at what backs it.
        uint256 recoverable = p.availableLiquidity() + _collectable(p, v, whale) + _collectable(p, v, alice);
        assertLt(recoverable, p.totalSupplied(), "before: the books overstate the pool");

        vm.prank(keeper);
        v.writeOffBadDebt(alice);

        recoverable = p.availableLiquidity() + _collectable(p, v, whale) + _collectable(p, v, alice);
        assertGe(recoverable, p.totalSupplied(), "after: every supplier claim is backed");
    }

    /// @dev What a loan can actually produce: the debt, capped at what could
    /// be seized against it.
    function _collectable(BorrowLiquidityPool p, CollateralVault v, address user) internal view returns (uint256) {
        uint256 debt = p.balanceOfDebt(user);
        uint256 backing = _seizableOn(v, user);
        return debt < backing ? debt : backing;
    }

    /// The index is floored at one inside `absorbBadDebt`, because `supply`
    /// divides by it — a zero there is not "suppliers lost everything" but a
    /// pool that reverts on every future deposit, permanently.
    ///
    /// This test is why that floor is defence rather than a live concern, and
    /// the reasoning is worth keeping: **the loss can never reach everything
    /// standing behind it.** Collateral and debt are the same asset here, and
    /// the LTV ceiling is 50%, so a position always starts with at least twice
    /// the collateral it owes. The shortfall is `debt - collateral`, and what
    /// stands behind it is `supplied + reserves` — which grows out of the same
    /// interest the debt does. The collateral recovered is what separates
    /// them, and it is bounded below by construction.
    ///
    /// Driven at the worst case the design allows: one borrower, one supplier,
    /// utilization pinned at 100% so the curve runs at its steepest, and five
    /// years of it.
    ///
    /// The floor stops mattering the day collateral stops being the borrowed
    /// asset. A different collateral behind a price feed can fall to nothing,
    /// and then a total wipeout is a market move rather than an impossibility.
    function test_theLossCannotReachEverythingBehindIt() public {
        (BorrowLiquidityPool p, CollateralVault v) = _deploy(1e17);

        // The supply is exactly what alice borrows, so utilization pins at
        // 100% and the borrow rate runs past the kink at its steepest.
        vm.prank(lender);
        p.supply(500 ether);

        vm.prank(alice);
        v.deposit(1_000 ether, alice);
        uint256 ceiling = v.maxBorrowable(alice);
        vm.prank(alice);
        v.borrow(ceiling);

        vm.warp(block.timestamp + 5 * YEAR);
        p.accrue();

        uint256 collateral = _seizableOn(v, alice);
        uint256 shortfall = v.lienOf(alice) - collateral;
        uint256 behindIt = p.totalSupplied() + p.totalReserves();

        assertGt(shortfall, 0, "setup: the position is genuinely uncollectable");
        assertLt(shortfall, behindIt, "the loss is strictly smaller than the claims behind it");
        assertApproxEqAbs(behindIt - shortfall, collateral, 1e15, "and the gap between them is exactly the collateral");

        vm.prank(keeper);
        v.writeOffBadDebt(alice);

        assertGt(p.supplyIndex(), 0, "so the index never approaches the floor");
        assertEq(p.unsocialisedBadDebt(), 0, "and nothing falls off the end");
    }

    function testFuzz_writeOffNeverIncreasesASupplierBalance(uint8 yearsUnder, uint96 secondStake) public {
        (BorrowLiquidityPool p, CollateralVault v) = _deployWithoutReserves();
        uint256 stake = bound(secondStake, 1 ether, 400_000 ether);
        vm.prank(lender2);
        p.supply(stake);

        _driveAliceUnderOn(p, v, bound(yearsUnder, 5, 12));
        vm.assume(v.lienOf(alice) > _seizableOn(v, alice));

        uint256 oneBefore = p.balanceOfSupply(lender);
        uint256 twoBefore = p.balanceOfSupply(lender2);

        vm.prank(keeper);
        v.writeOffBadDebt(alice);

        assertLe(p.balanceOfSupply(lender), oneBefore, "a write-off can only ever take");
        assertLe(p.balanceOfSupply(lender2), twoBefore, "a write-off can only ever take");
        assertEq(v.lienOf(alice), 0, "and it always finishes the job");
        // `supply` divides by the index, so a zero here is a permanently
        // bricked pool rather than a wiped-out one.
        assertGt(p.supplyIndex(), 0, "the index never reaches zero");
    }
}
