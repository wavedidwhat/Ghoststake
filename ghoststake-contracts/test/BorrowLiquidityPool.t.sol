// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";

contract BorrowLiquidityPoolTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;

    // Placeholder curve, per GHO-25: not tuned like a real money market.
    // 0% base, +4% APR up to an 80% kink, +75% APR steeply above it,
    // 10% of borrow interest to reserves.
    uint256 internal constant BASE = 0;
    uint256 internal constant SLOPE1 = uint256(4e16) / YEAR;
    uint256 internal constant SLOPE2 = uint256(75e16) / YEAR;
    uint256 internal constant KINK = 8e17; // 0.8 WAD
    uint256 internal constant RESERVE_FACTOR = 1e17; // 0.1 WAD

    BorrowLiquidityPool internal pool;
    ERC20Mock internal token;

    address internal owner = makeAddr("owner");
    address internal module = makeAddr("borrowModule");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal borrower = makeAddr("borrower");

    function setUp() public {
        token = new ERC20Mock();
        pool = new BorrowLiquidityPool(IERC20(address(token)), BASE, SLOPE1, SLOPE2, KINK, RESERVE_FACTOR, owner);

        vm.prank(owner);
        pool.setBorrowModule(module);

        address[4] memory funded = [alice, bob, module, borrower];
        for (uint256 i = 0; i < funded.length; i++) {
            token.mint(funded[i], 10_000_000 ether);
            vm.prank(funded[i]);
            token.approve(address(pool), type(uint256).max);
        }
    }

    /// @dev Borrow flows out to the module, which forwards to the borrower.
    /// GHO-8 will own this; here the module just holds the funds.
    function _borrow(uint256 amount, address onBehalfOf) internal {
        vm.prank(module);
        pool.borrow(amount, onBehalfOf);
    }

    // ---------------------------------------------------------------
    // The interest rate curve
    // ---------------------------------------------------------------

    function test_rateIsBaseAtZeroUtilization() public view {
        assertEq(pool.utilization(), 0);
        assertEq(pool.borrowRatePerSecond(), BASE);
        assertEq(pool.supplyRatePerSecond(), 0, "nobody earns when nothing is lent");
    }

    function test_curveIsShallowBelowKinkAndSteepAbove() public {
        vm.prank(alice);
        pool.supply(1_000 ether);

        _borrow(400 ether, borrower); // 40% utilization
        uint256 rateBelow = pool.borrowRatePerSecond();
        assertApproxEqRel(pool.utilization(), 4e17, 0.001e18);

        _borrow(500 ether, borrower); // 90% utilization, past the kink
        uint256 rateAbove = pool.borrowRatePerSecond();
        assertApproxEqRel(pool.utilization(), 9e17, 0.001e18);

        assertGt(rateAbove, rateBelow * 5, "past the kink the curve must bite, not drift");
    }

    function test_rateAtExactlyKinkIsBasePlusSlope1() public {
        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(800 ether, borrower); // exactly 80%

        assertEq(pool.utilization(), KINK);
        assertEq(pool.borrowRatePerSecond(), BASE + SLOPE1, "kink is where slope1 is fully applied");
    }

    /// @dev Suppliers only earn on the lent fraction, less the reserve cut.
    function test_supplyRateIsBorrowRateScaledByUtilizationLessReserve() public {
        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(500 ether, borrower);

        uint256 u = pool.utilization();
        uint256 expected = (((pool.borrowRatePerSecond() * u) / WAD) * (WAD - RESERVE_FACTOR)) / WAD;
        assertEq(pool.supplyRatePerSecond(), expected);
        assertLt(
            pool.supplyRatePerSecond(), pool.borrowRatePerSecond(), "suppliers always earn less than borrowers pay"
        );
    }

    // ---------------------------------------------------------------
    // Supply and withdraw
    // ---------------------------------------------------------------

    function test_supplyThenWithdrawRoundTripWithNoBorrowers() public {
        uint256 before = token.balanceOf(alice);

        vm.startPrank(alice);
        pool.supply(1_000 ether);
        vm.warp(block.timestamp + 365 days);
        pool.withdraw(pool.balanceOfSupply(alice));
        vm.stopPrank();

        assertEq(token.balanceOf(alice), before, "no borrowers means no yield, and no loss either");
        assertEq(pool.balanceOfSupply(alice), 0);
    }

    function test_supplierEarnsInterestPaidByBorrower() public {
        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(500 ether, borrower);

        vm.warp(block.timestamp + 365 days);
        pool.accrue();

        assertGt(pool.balanceOfSupply(alice), 1_000 ether, "supplier earned");
        assertGt(pool.balanceOfDebt(borrower), 500 ether, "borrower owes more than drawn");
    }

    function test_fullWithdrawLeavesNoDust() public {
        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(500 ether, borrower);
        vm.warp(block.timestamp + 90 days);

        // Borrower repays so there's liquidity to exit against.
        pool.accrue();
        uint256 debt = pool.balanceOfDebt(borrower);
        token.mint(borrower, debt); // cover accrued interest
        vm.prank(borrower);
        pool.repay(debt, borrower);

        uint256 supplyBalance = pool.balanceOfSupply(alice);
        vm.prank(alice);
        pool.withdraw(supplyBalance);

        assertEq(pool.balanceOfSupply(alice), 0, "no scaled dust may survive a full exit");
        assertEq(pool.scaledSupply(alice), 0);
    }

    // ---------------------------------------------------------------
    // The liquidity lock — GHO-25's named failure mode
    // ---------------------------------------------------------------

    function test_withdrawRevertsWithNamedErrorWhenFundsAreLentOut() public {
        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(900 ether, borrower);

        // Alice's balance is fine; the liquidity is not there.
        assertGe(pool.balanceOfSupply(alice), 1_000 ether);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(BorrowLiquidityPool.InsufficientLiquidity.selector, 1_000 ether, 100 ether)
        );
        pool.withdraw(1_000 ether);
    }

    function test_partialWithdrawUpToAvailableLiquiditySucceeds() public {
        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(900 ether, borrower);

        vm.prank(alice);
        pool.withdraw(100 ether); // exactly what's left
        assertEq(pool.availableLiquidity(), 0);
    }

    function test_borrowRevertsWhenPoolIsDry() public {
        vm.prank(alice);
        pool.supply(1_000 ether);

        vm.prank(module);
        vm.expectRevert(
            abi.encodeWithSelector(BorrowLiquidityPool.InsufficientLiquidity.selector, 1_001 ether, 1_000 ether)
        );
        pool.borrow(1_001 ether, borrower);
    }

    // ---------------------------------------------------------------
    // Access control
    // ---------------------------------------------------------------

    function test_onlyBorrowModuleCanBorrow() public {
        vm.prank(alice);
        pool.supply(1_000 ether);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BorrowLiquidityPool.NotBorrowModule.selector, alice));
        pool.borrow(100 ether, alice);
    }

    /// @dev Repay is open to anyone on purpose — a third party clearing your
    /// debt can only help, and GHO-9 liquidation depends on it.
    function test_anyoneCanRepayOnBehalfOfAnother() public {
        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(500 ether, borrower);
        vm.warp(block.timestamp + 30 days);
        pool.accrue();

        uint256 debt = pool.balanceOfDebt(borrower);
        token.mint(bob, debt);
        vm.prank(bob);
        pool.repay(debt, borrower);

        assertEq(pool.balanceOfDebt(borrower), 0, "debt cleared by a stranger");
    }

    function test_repayCannotExceedDebt() public {
        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(500 ether, borrower);

        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(BorrowLiquidityPool.RepayExceedsDebt.selector, 600 ether, 500 ether));
        pool.repay(600 ether, borrower);
    }

    // ---------------------------------------------------------------
    // Reserves
    // ---------------------------------------------------------------

    function test_reservesAccrueFromBorrowInterest() public {
        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(500 ether, borrower);

        vm.warp(block.timestamp + 365 days);
        pool.accrue();

        assertGt(pool.totalReserves(), 0, "protocol took its cut");
    }

    function test_reservesAreNotLendableOrWithdrawableBySuppliers() public {
        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(500 ether, borrower);
        vm.warp(block.timestamp + 365 days);
        pool.accrue();

        uint256 owed = pool.balanceOfDebt(borrower);
        token.mint(borrower, owed);
        vm.prank(borrower);
        pool.repay(owed, borrower);

        uint256 rawBalance = token.balanceOf(address(pool));
        assertEq(pool.availableLiquidity(), rawBalance - pool.totalReserves(), "reserves excluded from lendable");
    }

    function test_onlyOwnerWithdrawsReserves() public {
        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(500 ether, borrower);
        vm.warp(block.timestamp + 365 days);
        pool.accrue();
        uint256 owed = pool.balanceOfDebt(borrower);
        token.mint(borrower, owed);
        vm.prank(borrower);
        pool.repay(owed, borrower);

        uint256 reserves = pool.totalReserves();
        vm.prank(alice);
        vm.expectRevert();
        pool.withdrawReserves(alice, reserves);

        vm.prank(owner);
        pool.withdrawReserves(owner, reserves);
        assertEq(pool.totalReserves(), 0);
    }

    // ---------------------------------------------------------------
    // Why the index exists — the tests that justify the design
    // ---------------------------------------------------------------

    /// @dev THE test for this issue. A supplier who never touches their
    /// position across a rate change must still be priced correctly for
    /// each period at that period's rate. A per-user rate snapshot (what
    /// CollateralVault did before this) gets this wrong: it would price the
    /// whole span at whatever the rate was when they last interacted.
    function test_supplierIsPricedCorrectlyAcrossARateChangeTheyNeverTouched() public {
        vm.prank(alice);
        pool.supply(1_000 ether);

        // Period 1: low utilization, shallow rate.
        _borrow(200 ether, borrower);
        uint256 lowRate = pool.supplyRatePerSecond();
        vm.warp(block.timestamp + 180 days);

        // Rate jumps. Alice does nothing at all.
        _borrow(700 ether, borrower); // now ~90%, past the kink
        uint256 highRate = pool.supplyRatePerSecond();
        assertGt(highRate, lowRate * 5, "the rate genuinely moved");

        vm.warp(block.timestamp + 180 days);
        pool.accrue();

        uint256 earned = pool.balanceOfSupply(alice) - 1_000 ether;

        // Must land strictly between "all at the low rate" and "all at the
        // high rate" — i.e. each period priced at its own rate.
        uint256 allLow = (1_000 ether * lowRate * 360 days) / WAD;
        uint256 allHigh = (1_000 ether * highRate * 360 days) / WAD;

        assertGt(earned, allLow, "not priced entirely at the stale low rate");
        assertLt(earned, allHigh, "not priced entirely at the new high rate");
    }

    /// @dev The same property for debt: a borrower who never touches their
    /// loan across a rate change owes each period at that period's rate.
    function test_borrowerIsChargedCorrectlyAcrossARateChange() public {
        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(200 ether, borrower);

        uint256 lowRate = pool.borrowRatePerSecond();
        vm.warp(block.timestamp + 180 days);

        _borrow(700 ether, bob); // pushes utilization up; borrower is untouched
        uint256 highRate = pool.borrowRatePerSecond();
        vm.warp(block.timestamp + 180 days);
        pool.accrue();

        uint256 owed = pool.balanceOfDebt(borrower) - 200 ether;
        uint256 allLow = (200 ether * lowRate * 360 days) / WAD;
        uint256 allHigh = (200 ether * highRate * 360 days) / WAD;

        assertGt(owed, allLow);
        assertLt(owed, allHigh);
    }

    /// @dev Cost of accrual is constant regardless of how many positions
    /// exist — the whole point of an index over per-user settlement.
    function test_accrualCostDoesNotGrowWithUserCount() public {
        vm.prank(alice);
        pool.supply(1_000_000 ether);
        _borrow(500_000 ether, borrower);

        // Warm the index slots first — otherwise the first accrue pays
        // cold-storage costs and dominates the comparison.
        vm.warp(block.timestamp + 1 days);
        pool.accrue();

        vm.warp(block.timestamp + 1 days);
        uint256 gasOne = gasleft();
        pool.accrue();
        gasOne = gasOne - gasleft();

        // Add 50 more positions.
        for (uint256 i = 0; i < 50; i++) {
            address user = address(uint160(0xBEEF0000 + i));
            token.mint(user, 1_000 ether);
            vm.startPrank(user);
            token.approve(address(pool), type(uint256).max);
            pool.supply(1_000 ether);
            vm.stopPrank();
        }

        vm.warp(block.timestamp + 1 days);
        uint256 gasMany = gasleft();
        pool.accrue();
        gasMany = gasMany - gasleft();

        assertApproxEqRel(gasMany, gasOne, 0.2e18, "accrual must be O(1), not O(users)");
    }

    /// @dev Characterization test, not a correctness one. The index
    /// compounds per accrual, so cadence has a small effect. This pins the
    /// magnitude so a future change can't widen it unnoticed. See the
    /// contract NatSpec for why it isn't eliminated.
    function test_accrueCadenceEffectIsNegligible() public {
        uint256 snapshot = vm.snapshotState();

        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(500 ether, borrower);
        uint256 start = block.timestamp;

        vm.warp(start + 365 days);
        pool.accrue();
        uint256 lazyBalance = pool.balanceOfSupply(alice);

        vm.revertToState(snapshot);

        vm.prank(alice);
        pool.supply(1_000 ether);
        _borrow(500 ether, borrower);
        for (uint256 i = 1; i <= 365; i++) {
            vm.warp(start + i * 1 days);
            pool.accrue();
        }
        uint256 grindBalance = pool.balanceOfSupply(alice);

        assertGe(grindBalance, lazyBalance);
        assertApproxEqRel(grindBalance, lazyBalance, 0.0005e18, "cadence effect must stay under 0.05%");
    }

    // ---------------------------------------------------------------
    // Solvency
    // ---------------------------------------------------------------

    /// @dev The pool must never promise suppliers more than borrowers owe
    /// plus what's actually sitting in it.
    function testFuzz_poolNeverPromisesMoreThanItHolds(uint96 supplyAmount, uint96 borrowPct, uint32 elapsed) public {
        supplyAmount = uint96(bound(supplyAmount, 1e18, 1_000_000 ether));
        uint256 borrowAmount = (uint256(supplyAmount) * bound(borrowPct, 1, 99)) / 100;

        token.mint(alice, supplyAmount);
        vm.startPrank(alice);
        token.approve(address(pool), type(uint256).max);
        pool.supply(supplyAmount);
        vm.stopPrank();

        _borrow(borrowAmount, borrower);
        vm.warp(block.timestamp + elapsed);
        pool.accrue();

        assertLe(
            pool.totalSupplied(),
            pool.availableLiquidity() + pool.totalBorrowed() + 1e12,
            "supplier claims must be covered by cash plus outstanding debt"
        );
    }

    function testFuzz_repayThenWithdrawAlwaysClearsBothSides(uint96 amount, uint32 elapsed) public {
        amount = uint96(bound(amount, 1e18, 1_000_000 ether));
        elapsed = uint32(bound(elapsed, 0, 10 * 365 days));
        token.mint(alice, amount);

        vm.startPrank(alice);
        token.approve(address(pool), type(uint256).max);
        pool.supply(amount);
        vm.stopPrank();

        _borrow(amount / 2, borrower);
        vm.warp(block.timestamp + elapsed);
        pool.accrue();

        uint256 debt = pool.balanceOfDebt(borrower);
        token.mint(borrower, debt);
        vm.prank(borrower);
        pool.repay(debt, borrower);
        assertEq(pool.balanceOfDebt(borrower), 0);

        uint256 supplyBalance = pool.balanceOfSupply(alice);
        vm.prank(alice);
        pool.withdraw(supplyBalance);
        assertEq(pool.balanceOfSupply(alice), 0);
    }
}
