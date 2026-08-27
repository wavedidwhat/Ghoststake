// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";
import { CollateralVault, ILienSource } from "../src/CollateralVault.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";
import { MockRoundOracle } from "./mocks/MockRoundOracle.sol";
import { RepayingRouter, SafeRepayingRouter } from "./mocks/RepayingRouter.sol";

/// @notice GHO-16: what happens when a position is liquidated while the
/// borrowed funds are still locked in a live round.
///
/// This is a decision issue, and these tests are the evidence behind it. They
/// establish two things a written argument could only assert:
///
///  1. Liquidation is unaffected by an open round, because the collateral
///     never left the vault. Nothing needs building to allow it.
///  2. The obvious router *does* break — not at liquidation, but afterwards,
///     when the round settles against a debt that no longer exists.
contract LiquidationWithOpenPositionTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant FIVE_PERCENT_APR = uint256(5e16) / YEAR;

    BorrowLiquidityPool internal pool;
    CollateralVault internal vault;
    ParimutuelRound internal market;
    MockRoundOracle internal oracle;
    ERC20Mock internal token;

    address internal owner = makeAddr("owner");
    address internal lender = makeAddr("lender");
    address internal alice = makeAddr("alice"); // borrows, stakes, goes under
    address internal carol = makeAddr("carol"); // takes the other side
    address internal whale = makeAddr("whale"); // drives utilization
    address internal keeper = makeAddr("keeper"); // liquidator

    function setUp() public {
        token = new ERC20Mock();

        pool = new BorrowLiquidityPool(
            IERC20(address(token)), 0, uint256(4e16) / YEAR, uint256(75e16) / YEAR, 8e17, 1e17, owner, owner
        );
        vault = new CollateralVault(
            IERC20(address(token)),
            FIVE_PERCENT_APR,
            ILienSource(address(pool)),
            CollateralVault.RiskParams({
                maxLTV: 5e17,
                liquidationThreshold: 65e16,
                liquidationBonus: 5e16,
                closeFactor: 5e17
            }),
            address(this)
        );
        vm.prank(owner);
        pool.setBorrowModule(address(vault));

        oracle = new MockRoundOracle(2000e18);
        market = new ParimutuelRound(
            IERC20(address(token)),
            IRoundOracle(address(oracle)),
            2e16,
            ParimutuelRound.Timing({ entryCutoff: 15, lockWindow: 60, resolveDeadline: 1 hours }),
            1 ether,
            owner,
            owner
        );

        address[5] memory users = [alice, carol, lender, whale, keeper];
        for (uint256 i = 0; i < users.length; i++) {
            token.mint(users[i], 5_000_000 ether);
            vm.startPrank(users[i]);
            token.approve(address(vault), type(uint256).max);
            token.approve(address(pool), type(uint256).max);
            token.approve(address(market), type(uint256).max);
            vm.stopPrank();
        }

        vm.prank(lender);
        pool.supply(500_000 ether);
    }

    /// @dev Borrow at the ceiling, then let interest run at high utilization
    /// until the lien overtakes the liquidation line. The honest route.
    function _driveAliceUnderwater() internal returns (uint256 borrowed) {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        borrowed = vault.maxBorrowable(alice);
        vm.prank(alice);
        vault.borrow(borrowed);

        vm.prank(whale);
        vault.deposit(1_000_000 ether, whale);
        vm.prank(whale);
        vault.borrow(450_000 ether);

        for (uint256 i = 0; i < 60; i++) {
            vm.warp(block.timestamp + 15 days);
            pool.accrue();
            if (vault.isLiquidatable(alice)) break;
        }
        require(vault.isLiquidatable(alice), "setup: alice never went under");
    }

    function _openRound() internal returns (uint256 roundId) {
        vm.prank(owner);
        roundId = market.openRound(
            uint64(block.timestamp), uint64(block.timestamp + 10 minutes), uint64(block.timestamp + 20 minutes)
        );
    }

    // ------------------------------------------------------------------
    // 1. Liquidation is not blocked, and needs nothing built
    // ------------------------------------------------------------------

    /// @dev The core finding. Collateral stays in the vault; only the
    /// *borrowed* funds go into a round. So a liquidator can always be paid
    /// from collateral, whatever the round is doing.
    function test_liquidationWorksWhileTheBorrowedFundsAreStakedInALiveRound() public {
        uint256 borrowed = _driveAliceUnderwater();

        // Alice stakes the borrowed funds. They are now locked in the round.
        uint256 roundId = _openRound();
        vm.prank(alice);
        market.takePosition(roundId, ParimutuelRound.Side.Up, borrowed);

        assertTrue(vault.isLiquidatable(alice), "alice should be liquidatable");
        uint256 lienBefore = vault.lienOf(alice);
        uint256 keeperCollateralBefore = token.balanceOf(keeper);

        // Hoisted deliberately: `vm.prank` applies to the *next* call, and an
        // inline view in the arguments is that call — the liquidation would
        // run as the test contract, which has no allowance. Same trap as
        // ADR 0011.
        uint256 repayable = vault.maxLiquidatableDebt(alice);
        vm.prank(keeper);
        vault.liquidate(alice, repayable);

        assertLt(vault.lienOf(alice), lienBefore, "debt should have fallen");
        assertGt(token.balanceOf(keeper), keeperCollateralBefore - lienBefore, "keeper took collateral");

        // The round position is untouched: it is not collateral and was
        // never the liquidator's to take.
        assertEq(market.stakeOf(roundId, alice, ParimutuelRound.Side.Up), borrowed, "the staked position was disturbed");
    }

    /// @dev And the health factor improves, so the round genuinely is
    /// irrelevant to whether liquidation achieves its purpose.
    function test_liquidationStillRepairsHealthWithAPositionOpen() public {
        uint256 borrowed = _driveAliceUnderwater();
        uint256 roundId = _openRound();
        vm.prank(alice);
        market.takePosition(roundId, ParimutuelRound.Side.Up, borrowed);

        uint256 healthBefore = vault.healthFactor(alice);
        uint256 repayable = vault.maxLiquidatableDebt(alice);
        vm.prank(keeper);
        vault.liquidate(alice, repayable);

        assertGt(vault.healthFactor(alice), healthBefore, "liquidation did not improve health");
    }

    // ------------------------------------------------------------------
    // 2. The breakage is *after* liquidation, in settlement
    // ------------------------------------------------------------------

    /// @dev The finding this issue exists for.
    ///
    /// Liquidation clears the whole lien. The round then resolves in alice's
    /// favour, and the router tries to repay a debt that is already gone —
    /// `repay` reverts with `NothingToRepay`, the sink reverts, and the claim
    /// is unrecoverable.
    function test_theObviousRouterBricksAClaimOnceTheDebtIsCleared() public {
        RepayingRouter router = new RepayingRouter(market, vault, IERC20(address(token)));
        vm.prank(owner);
        market.setRouter(address(router), true);

        uint256 roundId = _openRound();

        // The router stakes on alice's behalf, as GHO-15's would.
        token.mint(address(router), 100 ether);
        router.open(roundId, alice, ParimutuelRound.Side.Up, 100 ether);
        vm.prank(carol);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 100 ether);

        // Alice has no debt at all here — the simplest version of "the debt
        // is gone by the time the round settles".
        assertEq(vault.lienOf(alice), 0, "alice should have no lien");

        _resolveUp(roundId);

        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NothingToRepay.selector, alice));
        market.claim(roundId, alice);
    }

    /// @dev And it is not one user's problem. The round contract routes every
    /// claim through the sink, so one reverting settlement takes down claims
    /// for everyone the router funded — ADR 0013, finding 5, reached through
    /// a path that will occur in normal use rather than a malicious router.
    function test_oneBrokenSettlementStrandsEveryClaimThatRouterFunded() public {
        RepayingRouter router = new RepayingRouter(market, vault, IERC20(address(token)));
        vm.prank(owner);
        market.setRouter(address(router), true);

        uint256 roundId = _openRound();
        token.mint(address(router), 200 ether);
        router.open(roundId, alice, ParimutuelRound.Side.Up, 100 ether);
        router.open(roundId, carol, ParimutuelRound.Side.Up, 100 ether);

        vm.prank(whale);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 50 ether);

        _resolveUp(roundId);

        // Neither winner can claim, and neither did anything wrong.
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NothingToRepay.selector, alice));
        market.claim(roundId, alice);

        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NothingToRepay.selector, carol));
        market.claim(roundId, carol);
    }

    // ------------------------------------------------------------------
    // 3. The decision, demonstrated
    // ------------------------------------------------------------------

    /// @dev The router GHO-15 should build: cap the repayment at what is
    /// owed, skip it entirely at zero, and forward the remainder to the user.
    function test_aRouterThatNeverRevertsSettlesCleanly() public {
        SafeRepayingRouter router = new SafeRepayingRouter(market, vault, IERC20(address(token)));
        vm.prank(owner);
        market.setRouter(address(router), true);

        uint256 roundId = _openRound();
        token.mint(address(router), 100 ether);
        router.open(roundId, alice, ParimutuelRound.Side.Up, 100 ether);
        vm.prank(carol);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 100 ether);

        assertEq(vault.lienOf(alice), 0, "alice has no debt to absorb the payout");
        uint256 aliceBefore = token.balanceOf(alice);

        _resolveUp(roundId);
        market.claim(roundId, alice);

        // With no debt, the entire payout reaches alice rather than reverting
        // or being stranded inside the router.
        assertGt(token.balanceOf(alice), aliceBefore, "alice received nothing");
        assertEq(router.repaidForUser(alice), 0, "nothing should have been repaid");
        assertEq(token.balanceOf(address(router)), 0, "the router kept funds");
    }

    /// @dev With a live debt the payout goes to the creditor first, and only
    /// the excess to the user. Both halves land.
    function test_aPartialDebtIsRepaidAndTheRestReturned() public {
        SafeRepayingRouter router = new SafeRepayingRouter(market, vault, IERC20(address(token)));
        vm.prank(owner);
        market.setRouter(address(router), true);

        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        vm.prank(alice);
        vault.borrow(50 ether);
        uint256 lienBefore = vault.lienOf(alice);

        uint256 roundId = _openRound();
        token.mint(address(router), 100 ether);
        router.open(roundId, alice, ParimutuelRound.Side.Up, 100 ether);
        vm.prank(carol);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 100 ether);

        uint256 aliceBefore = token.balanceOf(alice);
        _resolveUp(roundId);
        market.claim(roundId, alice);

        assertLt(vault.lienOf(alice), lienBefore, "the debt was not reduced");
        assertGt(token.balanceOf(alice), aliceBefore, "the surplus never reached alice");
        assertEq(token.balanceOf(address(router)), 0, "the router kept the surplus");
    }

    /// @dev Locks at the strike, then settles against a higher price so Up
    /// wins. The feed round is advanced explicitly, because that is what the
    /// round contract pins settlement to.
    function _resolveUp(uint256 roundId) internal {
        ParimutuelRound.Round memory round = market.rounds(roundId);

        vm.warp(round.lockTime);
        market.lockRound(roundId);

        oracle.setPrice(2100e18); // publishes a new feed round: Up wins
        uint80 closeRound = oracle.oracleRoundId();

        vm.warp(uint256(round.closeTime) + 1);
        market.resolveRound(roundId, closeRound);
    }
}
