// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";
import { StockLoanVault, IStockLoanPool } from "../src/StockLoanVault.sol";
import { AggregatorV3Interface } from "../src/interfaces/AggregatorV3Interface.sol";
import { DemoPriceFeed } from "../src/demo/DemoPriceFeed.sol";
import { MockUSDC } from "../script/mocks/MockUSDC.sol";

/// @dev The parts of Robinhood's `Stock` that matter to a lender: a UI
/// multiplier that moves on a split, and a pause that reverts every transfer.
contract MockStock is ERC20 {
    uint256 public uiMultiplier = 1e18;
    bool public paused;

    constructor(string memory n) ERC20(n, n) { }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function setMultiplier(uint256 m) external {
        uiMultiplier = m;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function _update(address from, address to, uint256 v) internal override {
        require(!paused, "IsPaused");
        super._update(from, to, v);
    }
}

/// @dev A plain ERC-20 with no multiplier, to prove `scaledUI = false` prices at 1x.
contract MockPlain is ERC20 {
    constructor() ERC20("PLAIN", "PLAIN") { }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

contract StockLoanVaultTest is Test {
    uint256 constant WAD = 1e18;
    uint256 constant T0 = 1_800_000_000;

    address owner = makeAddr("owner");
    address lender = makeAddr("lender");
    address alice = makeAddr("alice");
    address liquidator = makeAddr("liquidator");
    address guardian = makeAddr("guardian");

    MockUSDC usdc;
    MockStock tsla;
    MockPlain amzn;
    DemoPriceFeed tslaFeed;
    DemoPriceFeed amznFeed;
    BorrowLiquidityPool pool;
    StockLoanVault vault;

    function setUp() public {
        vm.warp(T0);
        usdc = new MockUSDC();
        tsla = new MockStock("TSLA");
        amzn = new MockPlain();

        tslaFeed = new DemoPriceFeed(8, "TSLA / USD", address(this));
        amznFeed = new DemoPriceFeed(8, "AMZN / USD", address(this));
        tslaFeed.push(400e8);
        amznFeed.push(200e8);

        pool = new BorrowLiquidityPool(IERC20(address(usdc)), 0, 0, 0, 0.8e18, 0.1e18, owner, guardian);

        StockLoanVault.CollateralConfig[] memory cfg = new StockLoanVault.CollateralConfig[](2);
        cfg[0] = StockLoanVault.CollateralConfig({
            token: IERC20(address(tsla)),
            feed: AggregatorV3Interface(address(tslaFeed)),
            maxLTV: 0.4e18,
            liquidationThreshold: 0.55e18,
            liquidationBonus: 0.08e18,
            maxAge: 1 days,
            liquidationMaxAge: 5 days,
            scaledUI: true
        });
        cfg[1] = StockLoanVault.CollateralConfig({
            token: IERC20(address(amzn)),
            feed: AggregatorV3Interface(address(amznFeed)),
            maxLTV: 0.4e18,
            liquidationThreshold: 0.55e18,
            liquidationBonus: 0.08e18,
            maxAge: 1 days,
            liquidationMaxAge: 5 days,
            scaledUI: false
        });
        vault = new StockLoanVault(
            IStockLoanPool(address(pool)),
            cfg,
            0.005e18, // 0.5% origination
            0.25e18, // a quarter of the liquidation bonus
            0.5e18,
            guardian
        );
        vm.prank(owner);
        pool.setBorrowModule(address(vault));

        usdc.mint(lender, 1_000_000e6);
        vm.startPrank(lender);
        usdc.approve(address(pool), type(uint256).max);
        pool.supply(1_000_000e6);
        vm.stopPrank();

        tsla.mint(alice, 1000 ether);
        amzn.mint(alice, 1000 ether);
        usdc.mint(liquidator, 1_000_000e6);
        usdc.mint(alice, 1_000_000e6);
        vm.startPrank(alice);
        tsla.approve(address(vault), type(uint256).max);
        amzn.approve(address(vault), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);
        vm.stopPrank();
        vm.prank(liquidator);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @dev The feed only accepts a strictly newer timestamp.
    function _pushTsla(int256 price) internal {
        vm.warp(block.timestamp + 1);
        tslaFeed.push(price);
    }

    function _deposit100Tsla() internal {
        vm.prank(alice);
        vault.deposit(address(tsla), 100 ether); // $40,000 -> $16,000 limit
    }

    // ---------------------------------------------------------------
    // Valuation
    // ---------------------------------------------------------------

    function test_valueIsAmountTimesPriceInStableUnits() public view {
        // 100 shares at $400 = $40,000 in 6-decimal USDC.
        assertEq(vault.valueOf(address(tsla), 100 ether, 1 days), 40_000e6);
    }

    function test_aSplitDoesNotChangeValue() public {
        uint256 before = vault.valueOf(address(tsla), 100 ether, 1 days);
        // 2-for-1: raw balance untouched, multiplier doubles, price per share halves.
        tsla.setMultiplier(2e18);
        _pushTsla(200e8);
        assertEq(vault.valueOf(address(tsla), 100 ether, 1 days), before);
    }

    function test_forgettingTheMultiplierWouldHaveMisvalued() public {
        // The failure this guards: multiplier moves, price has not caught up.
        tsla.setMultiplier(2e18);
        assertEq(vault.valueOf(address(tsla), 100 ether, 1 days), 80_000e6);
    }

    function test_plainTokenIgnoresMultiplier() public view {
        assertEq(vault.valueOf(address(amzn), 100 ether, 1 days), 20_000e6);
    }

    // ---------------------------------------------------------------
    // Borrowing
    // ---------------------------------------------------------------

    function test_borrowPaysExactAmountAndFeeGoesToTreasury() public {
        _deposit100Tsla();
        uint256 before = usdc.balanceOf(alice);
        uint256 treasuryBefore = usdc.balanceOf(owner);

        vm.prank(alice);
        vault.borrow(10_000e6);

        assertEq(usdc.balanceOf(alice) - before, 10_000e6, "amount is exact");
        assertEq(usdc.balanceOf(owner) - treasuryBefore, 50e6, "0.5% fee in cash");
        assertEq(vault.debtOf(alice), 10_050e6, "fee is added to the debt");
    }

    function test_borrowCountsTheFeeAgainstTheLimit() public {
        _deposit100Tsla(); // limit 16,000
        // 15,950 + 0.5% = 15,029.75... pick an amount whose fee tips it over.
        vm.prank(alice);
        vm.expectPartialRevert(StockLoanVault.ExceedsBorrowLimit.selector);
        vault.borrow(15_950e6); // 15,950 + 79.75 = 16,029.75 > 16,000
        vm.prank(alice);
        vault.borrow(15_900e6); // 15,900 + 79.5 = 15,979.5
    }

    function test_borrowOverLimitReverts() public {
        _deposit100Tsla();
        vm.prank(alice);
        vm.expectPartialRevert(StockLoanVault.ExceedsBorrowLimit.selector);
        vault.borrow(16_001e6);
    }

    function test_multipleCollateralsAddUp() public {
        _deposit100Tsla();
        vm.prank(alice);
        vault.deposit(address(amzn), 100 ether); // +$20,000 -> +$8,000
        vm.prank(alice);
        vault.borrow(23_000e6); // limit 24,000, fee 115
    }

    function test_staleFeedBlocksNewBorrowing() public {
        _deposit100Tsla();
        vm.warp(T0 + 1 days + 1);
        vm.prank(alice);
        vm.expectPartialRevert(StockLoanVault.StalePrice.selector);
        vault.borrow(1_000e6);
    }

    function test_unrelatedDeadFeedBlocksNobody() public {
        _deposit100Tsla();
        vm.warp(T0 + 1 days - 1);
        // AMZN's feed is as old, but alice holds none of it.
        vm.prank(alice);
        vault.borrow(1_000e6);
    }

    // ---------------------------------------------------------------
    // Exits are never locked by a price
    // ---------------------------------------------------------------

    function test_withdrawWithNoDebtNeedsNoPrice() public {
        _deposit100Tsla();
        vm.warp(T0 + 365 days); // feed long dead
        vm.prank(alice);
        vault.withdraw(address(tsla), 100 ether);
        assertEq(tsla.balanceOf(alice), 1000 ether);
    }

    function test_repayNeedsNoPrice() public {
        _deposit100Tsla();
        vm.prank(alice);
        vault.borrow(10_000e6);
        vm.warp(T0 + 365 days);
        vm.prank(alice);
        vault.repay(type(uint256).max, alice);
        assertEq(vault.debtOf(alice), 0);
    }

    function test_withdrawWithDebtRespectsTheLimit() public {
        _deposit100Tsla();
        vm.prank(alice);
        vault.borrow(8_000e6); // 8,040 debt; needs 20,100 of value at 40%
        vm.prank(alice);
        vm.expectPartialRevert(StockLoanVault.WithdrawWouldExceedLimit.selector);
        vault.withdraw(address(tsla), 60 ether); // leaves $16,000 -> limit 6,400
        vm.prank(alice);
        vault.withdraw(address(tsla), 40 ether); // leaves $24,000 -> limit 9,600
    }

    function test_pausedEntriesStopArrivalsNotDepartures() public {
        _deposit100Tsla();
        vm.prank(alice);
        vault.borrow(5_000e6);

        vm.prank(guardian);
        vault.pauseEntries();

        vm.startPrank(alice);
        vm.expectRevert();
        vault.deposit(address(tsla), 1 ether);
        vm.expectRevert();
        vault.borrow(1e6);
        vault.repay(type(uint256).max, alice);
        vault.withdraw(address(tsla), 100 ether);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------
    // Liquidation
    // ---------------------------------------------------------------

    function _borrowToTheLimit() internal {
        _deposit100Tsla();
        vm.prank(alice);
        vault.borrow(15_900e6); // debt 15,979.5
    }

    function test_healthyPositionCannotBeLiquidated() public {
        _borrowToTheLimit();
        vm.prank(liquidator);
        vm.expectPartialRevert(StockLoanVault.PositionNotLiquidatable.selector);
        vault.liquidate(alice, address(tsla), 1_000e6);
    }

    function test_liquidationSeizesWithBonusAndPaysTheTreasury() public {
        _borrowToTheLimit();
        // Price falls to $250: value 25,000, line 13,750 < 15,979.5.
        _pushTsla(250e8);
        assertTrue(vault.isLiquidatable(alice));

        uint256 treasuryBefore = usdc.balanceOf(owner);
        uint256 tslaBefore = tsla.balanceOf(liquidator);
        uint256 debtBefore = vault.debtOf(alice);

        vm.prank(liquidator);
        vault.liquidate(alice, address(tsla), 4_000e6);

        // 4,000 repaid + 8% bonus = 4,320 of TSLA at $250.
        assertEq(tsla.balanceOf(liquidator) - tslaBefore, 17.28 ether, "seized incl. bonus");
        // Protocol takes a quarter of the 8% bonus: 4,000 x 0.08 x 0.25 = 80.
        assertEq(usdc.balanceOf(owner) - treasuryBefore, 80e6, "protocol share");
        assertEq(debtBefore - vault.debtOf(alice), 4_000e6, "debt reduced by the repayment");
    }

    function test_closeFactorCapsALiquidationNearTheLine() public {
        _borrowToTheLimit();
        _pushTsla(250e8); // hf ~0.86: above 0.55 x 1.08 = 0.594, so the cap holds
        vm.prank(liquidator);
        vm.expectPartialRevert(StockLoanVault.ExceedsCloseFactor.selector);
        vault.liquidate(alice, address(tsla), 9_000e6); // > 50% of 15,979.5
    }

    function test_aWeekendOldPriceStillLiquidates() public {
        _borrowToTheLimit();
        _pushTsla(250e8);
        vm.warp(T0 + 3 days); // Friday close to Monday: stale for borrowing, fine here
        assertTrue(vault.isLiquidatable(alice));
        vm.prank(liquidator);
        vault.liquidate(alice, address(tsla), 1_000e6);
    }

    function test_liquidatingATokenTheBorrowerDoesNotHoldReverts() public {
        _borrowToTheLimit();
        _pushTsla(250e8);
        vm.prank(liquidator);
        vm.expectPartialRevert(StockLoanVault.NothingToSeize.selector);
        vault.liquidate(alice, address(amzn), 1_000e6);
    }

    function test_aDeadFeedDoesNotLiquidate() public {
        _borrowToTheLimit();
        _pushTsla(250e8);
        vm.warp(T0 + 6 days);
        vm.prank(liquidator);
        vm.expectPartialRevert(StockLoanVault.StalePrice.selector);
        vault.liquidate(alice, address(tsla), 1_000e6);
    }

    function test_aPausedTokenCannotBeSeized() public {
        // The issuer's pause reverts the seizure transfer. Nothing here can
        // route around it; this test exists so the hazard is a known one.
        _borrowToTheLimit();
        _pushTsla(250e8);
        tsla.setPaused(true);
        vm.prank(liquidator);
        vm.expectRevert();
        vault.liquidate(alice, address(tsla), 1_000e6);
    }

    // ---------------------------------------------------------------
    // Bad debt
    // ---------------------------------------------------------------

    function test_writeOffSellsCollateralAndTheProceedsGoToLenders() public {
        _borrowToTheLimit();
        _pushTsla(100e8); // value 10,000 < debt 15,979.5
        assertEq(pool.balanceOfDebt(alice), 15_979_500_000);

        uint256 lenderBefore = pool.balanceOfSupply(lender);
        uint256 usdcBefore = usdc.balanceOf(liquidator);

        vm.prank(liquidator);
        vault.writeOffBadDebt(alice);

        // Buyer pays value / 1.08 = 9,259.259259 and gets all 100 TSLA.
        assertEq(usdcBefore - usdc.balanceOf(liquidator), 9_259_259_259, "buyer pays a discount");
        assertEq(tsla.balanceOf(liquidator), 100 ether, "buyer gets the collateral");
        assertEq(tsla.balanceOf(owner), 0, "the treasury holds none of it");
        assertEq(pool.balanceOfDebt(alice), 0);
        assertEq(vault.collateralOf(alice, address(tsla)), 0);

        // Lenders lose the shortfall, not the whole loan: 15,979.5 owed,
        // 9,259.26 recovered, ~6,720 lost, against 15,979.5 before the fix.
        uint256 lost = lenderBefore - pool.balanceOfSupply(lender);
        assertApproxEqAbs(lost, 15_979_500_000 - 9_259_259_259, 2);
    }

    function test_writeOffWithNothingLeftJustAbsorbsTheDebt() public {
        _borrowToTheLimit();
        _pushTsla(100e8);
        // A liquidator takes all 100 TSLA by repaying what it is worth to them
        // (10,000 / 1.08, rounded up so nothing is left); the loan is left with a shortfall and no collateral.
        vm.prank(liquidator);
        vault.liquidate(alice, address(tsla), 9_260e6);
        assertEq(vault.collateralOf(alice, address(tsla)), 0);
        assertGt(vault.debtOf(alice), 0);

        vm.prank(liquidator);
        vault.writeOffBadDebt(alice);
        assertEq(vault.debtOf(alice), 0);
    }

    function test_writeOffRefusesARecoverablePosition() public {
        _borrowToTheLimit();
        _pushTsla(250e8); // liquidatable, but value 25,000 > debt
        vm.prank(liquidator);
        vm.expectPartialRevert(StockLoanVault.NotWritableOff.selector);
        vault.writeOffBadDebt(alice);
    }

    // ---------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------

    function test_constructorRejectsAThresholdTheBonusCannotFit() public {
        StockLoanVault.CollateralConfig[] memory cfg = new StockLoanVault.CollateralConfig[](1);
        cfg[0] = StockLoanVault.CollateralConfig({
            token: IERC20(address(tsla)),
            feed: AggregatorV3Interface(address(tslaFeed)),
            maxLTV: 0.5e18,
            liquidationThreshold: 0.95e18,
            liquidationBonus: 0.08e18, // 0.95 x 1.08 > 1
            maxAge: 1 days,
            liquidationMaxAge: 5 days,
            scaledUI: true
        });
        vm.expectRevert(StockLoanVault.InvalidConfig.selector);
        new StockLoanVault(IStockLoanPool(address(pool)), cfg, 0, 0, 0.5e18, guardian);
    }

    function test_constructorRejectsAnExcessiveFee() public {
        StockLoanVault.CollateralConfig[] memory cfg = new StockLoanVault.CollateralConfig[](1);
        cfg[0] = StockLoanVault.CollateralConfig({
            token: IERC20(address(tsla)),
            feed: AggregatorV3Interface(address(tslaFeed)),
            maxLTV: 0.4e18,
            liquidationThreshold: 0.55e18,
            liquidationBonus: 0.08e18,
            maxAge: 1 days,
            liquidationMaxAge: 5 days,
            scaledUI: true
        });
        vm.expectRevert(StockLoanVault.InvalidConfig.selector);
        new StockLoanVault(IStockLoanPool(address(pool)), cfg, 0.05e18, 0, 0.5e18, guardian);
    }

    function test_unknownCollateralIsRejected() public {
        MockPlain other = new MockPlain();
        vm.expectRevert(abi.encodeWithSelector(StockLoanVault.UnknownCollateral.selector, address(other)));
        vault.deposit(address(other), 1);
    }
}
