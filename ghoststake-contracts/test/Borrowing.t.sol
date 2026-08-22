// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CollateralVault, ILienSource } from "../src/CollateralVault.sol";
import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";

/// @notice GHO-8: borrowing against collateral, bounded by LTV and watched by
/// a health factor.
///
/// The full stack is wired here — vault as the pool's borrow module, debt
/// priced by the pool's utilization curve — so these exercise the real path a
/// user takes rather than a mocked creditor.
contract BorrowingTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant MAX_LTV = 5e17; // 50%
    uint256 internal constant LIQ_THRESHOLD = 65e16; // 65%
    uint256 internal constant LIQ_BONUS = 5e16; // 5%
    uint256 internal constant CLOSE_FACTOR = 5e17; // 50%
    uint256 internal constant FULL_LIQ_THRESHOLD = 95e16; // HF 0.95
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
            IERC20(address(token)), 0, uint256(4e16) / YEAR, uint256(75e16) / YEAR, 8e17, 1e17, owner
        );

        vault = new CollateralVault(IERC20(address(token)), FIVE_PERCENT_APR, ILienSource(address(pool)), _risk());

        // The vault is the borrow module: it is the only contract that knows
        // what collateral backs a position.
        vm.prank(owner);
        pool.setBorrowModule(address(vault));

        address[3] memory users = [alice, bob, lender];
        for (uint256 i = 0; i < users.length; i++) {
            token.mint(users[i], 1_000_000 ether);
            vm.startPrank(users[i]);
            token.approve(address(vault), type(uint256).max);
            token.approve(address(pool), type(uint256).max);
            vm.stopPrank();
        }

        vm.prank(lender);
        pool.supply(500_000 ether);
    }

    function _deposit(address user, uint256 amount) internal {
        vm.prank(user);
        vault.deposit(amount, user);
    }

    // ---------------------------------------------------------------
    // Borrowing within the LTV
    // ---------------------------------------------------------------

    function test_borrowDeliversFundsAndOpensALien() public {
        _deposit(alice, 1_000 ether);
        uint256 walletBefore = token.balanceOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true, address(vault));
        emit CollateralVault.Borrowed(alice, 400 ether, 400 ether);
        vault.borrow(400 ether);

        assertEq(token.balanceOf(alice) - walletBefore, 400 ether, "funds reached the borrower");
        assertEq(vault.lienOf(alice), 400 ether, "lien opened");
    }

    /// @dev The headline claim: your stake keeps working while you borrow
    /// against it.
    function test_collateralStaysDepositedAndKeepsEarningWhileBorrowed() public {
        _deposit(alice, 1_000 ether);
        uint256 sharesBefore = vault.balanceOf(alice);

        vm.prank(alice);
        vault.borrow(400 ether);

        assertEq(vault.balanceOf(alice), sharesBefore, "shares untouched by borrowing");

        vm.warp(block.timestamp + 365 days);
        assertGt(vault.accruedYield(alice), 0, "collateral still earning while a lien is open");
    }

    function test_maxBorrowableTracksTheLTVCeiling() public {
        _deposit(alice, 1_000 ether);

        uint256 ceiling = vault.maxBorrowable(alice);
        assertApproxEqRel(ceiling, 500 ether, 0.001e18, "50% of collateral value");

        vm.prank(alice);
        vault.borrow(ceiling);
        assertEq(vault.maxBorrowable(alice), 0, "ceiling consumed");
    }

    function test_borrowRevertsAboveTheLTVCeiling() public {
        _deposit(alice, 1_000 ether);
        uint256 ceiling = vault.maxBorrowable(alice);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.ExceedsMaxLTV.selector, alice, ceiling + 1, ceiling));
        vault.borrow(ceiling + 1);
    }

    function test_borrowingTwiceRespectsTheCombinedCeiling() public {
        _deposit(alice, 1_000 ether);

        vm.startPrank(alice);
        vault.borrow(300 ether);
        uint256 remaining = vault.maxBorrowable(alice);

        vm.expectRevert();
        vault.borrow(remaining + 1 ether);

        vault.borrow(remaining); // exactly the rest is fine
        vm.stopPrank();

        assertEq(vault.maxBorrowable(alice), 0);
    }

    function test_borrowRevertsWithNoCollateral() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.ExceedsMaxLTV.selector, alice, 1 ether, 0));
        vault.borrow(1 ether);
    }

    // ---------------------------------------------------------------
    // Health factor
    // ---------------------------------------------------------------

    function test_healthFactorIsMaxWithNoLien() public {
        _deposit(alice, 1_000 ether);
        assertEq(vault.healthFactor(alice), type(uint256).max, "no debt cannot be liquidated");
    }

    /// @dev Borrowing at the LTV ceiling must still leave a real buffer. If
    /// origination landed at HF 1.0, a single block of interest would make the
    /// position liquidatable.
    function test_borrowingAtTheCeilingStillLeavesABuffer() public {
        _deposit(alice, 1_000 ether);

        uint256 ceiling = vault.maxBorrowable(alice);
        vm.prank(alice);
        vault.borrow(ceiling);

        uint256 hf = vault.healthFactor(alice);
        assertGt(hf, WAD, "must open above the liquidation line");
        // 50% LTV against a 65% threshold => 0.65 / 0.50 = 1.3
        assertApproxEqRel(hf, 13e17, 0.01e18, "buffer is exactly the LTV-to-threshold gap");
    }

    function test_healthFactorFallsAsInterestAccrues() public {
        _deposit(alice, 1_000 ether);
        vm.prank(alice);
        vault.borrow(400 ether);

        uint256 hfBefore = vault.healthFactor(alice);

        // Push utilization past the kink so debt compounds meaningfully.
        _deposit(bob, 1_000_000 ether);
        vm.prank(bob);
        vault.borrow(450_000 ether);

        vm.warp(block.timestamp + 365 days);
        pool.accrue();

        assertLt(vault.healthFactor(alice), hfBefore, "debt grew, health fell");
    }

    function test_positionCanBecomeLiquidatable() public {
        _deposit(alice, 1_000 ether);
        uint256 ceiling = vault.maxBorrowable(alice);
        vm.prank(alice);
        vault.borrow(ceiling);

        _deposit(bob, 1_000_000 ether);
        vm.prank(bob);
        vault.borrow(450_000 ether);

        vm.warp(block.timestamp + 2 * 365 days);
        pool.accrue();

        assertLt(vault.healthFactor(alice), WAD, "position is now liquidatable; GHO-9 handles it");
    }

    // ---------------------------------------------------------------
    // Repayment
    // ---------------------------------------------------------------

    function test_repayClearsTheLienAndRestoresCapacity() public {
        _deposit(alice, 1_000 ether);
        vm.prank(alice);
        vault.borrow(400 ether);

        vm.prank(alice);
        vault.repay(400 ether, alice);

        assertEq(vault.lienOf(alice), 0);
        assertApproxEqRel(vault.maxBorrowable(alice), 500 ether, 0.001e18, "capacity restored");
    }

    function test_overpaymentIsCappedAtWhatIsOwed() public {
        _deposit(alice, 1_000 ether);
        vm.prank(alice);
        vault.borrow(400 ether);

        uint256 walletBefore = token.balanceOf(alice);
        vm.prank(alice);
        vault.repay(1_000 ether, alice); // far more than owed

        assertEq(vault.lienOf(alice), 0);
        assertEq(walletBefore - token.balanceOf(alice), 400 ether, "only the debt was taken");
    }

    function test_anyoneCanRepayAnotherPosition() public {
        _deposit(alice, 1_000 ether);
        vm.prank(alice);
        vault.borrow(400 ether);

        vm.prank(bob);
        vault.repay(400 ether, alice);

        assertEq(vault.lienOf(alice), 0, "a third party cleared it");
    }

    function test_repayRevertsWithNothingOwed() public {
        _deposit(alice, 1_000 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NothingToRepay.selector, alice));
        vault.repay(1 ether, alice);
    }

    // ---------------------------------------------------------------
    // Interaction with exit and transfer
    // ---------------------------------------------------------------

    function test_borrowThenExitSettlesTheLien() public {
        _deposit(alice, 1_000 ether);
        vm.prank(alice);
        vault.borrow(400 ether);

        uint256 walletBefore = token.balanceOf(alice);
        uint256 assets = vault.maxWithdraw(alice);
        uint256 shares = vault.balanceOf(alice);

        vm.prank(alice);
        vault.redeem(shares, alice, alice);

        assertEq(vault.lienOf(alice), 0);
        assertEq(token.balanceOf(alice) - walletBefore, assets - 400 ether, "collateral back, minus the lien");
    }

    function test_borrowedFundsPlusReturnedCollateralEqualTheStake() public {
        _deposit(alice, 1_000 ether);
        uint256 walletAfterDeposit = token.balanceOf(alice);

        vm.startPrank(alice);
        vault.borrow(400 ether);
        uint256 shares = vault.balanceOf(alice);
        vault.redeem(shares, alice, alice);
        vm.stopPrank();

        // Borrowed 400, gave 400 back out of collateral at exit: net zero.
        assertApproxEqAbs(
            token.balanceOf(alice), walletAfterDeposit + 1_000 ether, 1e12, "round trip returns the stake"
        );
    }

    function test_transferBlockedWhileBorrowed() public {
        _deposit(alice, 1_000 ether);
        vm.prank(alice);
        vault.borrow(400 ether);

        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.LienOutstanding.selector, alice, 400 ether));
        vault.transfer(bob, shares);
    }

    // ---------------------------------------------------------------
    // Properties
    // ---------------------------------------------------------------

    /// @dev The invariant that keeps the protocol solvent at origination.
    function testFuzz_borrowNeverOpensAnUnhealthyPosition(uint96 collateral, uint96 drawPct) public {
        collateral = uint96(bound(collateral, 1 ether, 100_000 ether));
        token.mint(alice, collateral);
        _deposit(alice, collateral);

        uint256 ceiling = vault.maxBorrowable(alice);
        vm.assume(ceiling > 0);
        uint256 draw = (ceiling * bound(drawPct, 1, 100)) / 100;
        vm.assume(draw > 0);

        vm.prank(alice);
        vault.borrow(draw);

        assertGt(vault.healthFactor(alice), WAD, "a new borrow is never immediately liquidatable");
    }

    function testFuzz_borrowThenFullRepayIsAlwaysReversible(uint96 collateral, uint32 elapsed) public {
        collateral = uint96(bound(collateral, 1 ether, 100_000 ether));
        elapsed = uint32(bound(elapsed, 0, 365 days));
        token.mint(alice, collateral);
        _deposit(alice, collateral);

        uint256 ceiling = vault.maxBorrowable(alice);
        vm.assume(ceiling > 0);

        vm.prank(alice);
        vault.borrow(ceiling);

        vm.warp(block.timestamp + elapsed);
        pool.accrue();

        uint256 owed = vault.lienOf(alice);
        token.mint(alice, owed);
        vm.prank(alice);
        vault.repay(owed, alice);

        assertEq(vault.lienOf(alice), 0, "a lien can always be cleared by paying it");
        assertEq(vault.healthFactor(alice), type(uint256).max);
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
