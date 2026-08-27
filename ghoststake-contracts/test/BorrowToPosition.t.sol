// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";
import { BorrowToPositionRouter } from "../src/BorrowToPositionRouter.sol";
import { CollateralVault, ILienSource } from "../src/CollateralVault.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";
import { MockRoundOracle } from "./mocks/MockRoundOracle.sol";

/// @notice GHO-15: borrow and take a position in one transaction, and unwind
/// it the same way.
///
/// The settlement half is held to the rules GHO-16 established, each of which
/// exists because the obvious version fails: cap the repayment, skip it at
/// zero, forward the surplus.
contract BorrowToPositionTest is Test {
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant FIVE_PERCENT_APR = uint256(5e16) / YEAR;

    BorrowLiquidityPool internal pool;
    CollateralVault internal vault;
    ParimutuelRound internal market;
    BorrowToPositionRouter internal router;
    MockRoundOracle internal oracle;
    ERC20Mock internal token;

    address internal owner = makeAddr("owner");
    address internal lender = makeAddr("lender");
    address internal alice = makeAddr("alice");
    address internal carol = makeAddr("carol");
    address internal keeper = makeAddr("keeper");

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

        router = new BorrowToPositionRouter(vault, market);
        vm.prank(owner);
        market.setRouter(address(router), true);

        address[4] memory users = [alice, carol, lender, keeper];
        for (uint256 i = 0; i < users.length; i++) {
            token.mint(users[i], 1_000_000 ether);
            vm.startPrank(users[i]);
            token.approve(address(vault), type(uint256).max);
            token.approve(address(pool), type(uint256).max);
            token.approve(address(market), type(uint256).max);
            token.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }

        vm.prank(lender);
        pool.supply(500_000 ether);
    }

    function _aliceReady(uint256 deposit, uint256 allowance) internal returns (uint256 roundId) {
        vm.prank(alice);
        vault.deposit(deposit, alice);
        vm.prank(alice);
        vault.approveBorrowDelegate(address(router), allowance);

        vm.prank(owner);
        roundId = market.openRound(
            uint64(block.timestamp), uint64(block.timestamp + 10 minutes), uint64(block.timestamp + 20 minutes)
        );
    }

    /// @dev Locks at the strike then settles higher, so Up wins.
    function _resolveUp(uint256 roundId) internal {
        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(round.lockTime);
        market.lockRound(roundId);
        oracle.setPrice(2100e18);
        uint80 closeRound = oracle.oracleRoundId();
        vm.warp(uint256(round.closeTime) + 1);
        market.resolveRound(roundId, closeRound);
    }

    function _resolveDown(uint256 roundId) internal {
        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(round.lockTime);
        market.lockRound(roundId);
        oracle.setPrice(1900e18);
        uint80 closeRound = oracle.oracleRoundId();
        vm.warp(uint256(round.closeTime) + 1);
        market.resolveRound(roundId, closeRound);
    }

    // ------------------------------------------------------------------
    // Opening
    // ------------------------------------------------------------------

    function test_borrowAndStakeInOneTransaction() public {
        uint256 roundId = _aliceReady(1_000 ether, 400 ether);

        uint256 walletBefore = token.balanceOf(alice);
        vm.prank(alice);
        uint256 staked = router.openPosition(roundId, ParimutuelRound.Side.Up, 300 ether, 0);

        assertEq(staked, 300 ether, "stake amount");
        assertEq(market.stakeOf(roundId, alice, ParimutuelRound.Side.Up), 300 ether, "position not opened");
        assertEq(vault.lienOf(alice), 300 ether, "debt not recorded against alice");

        // The whole point: the borrowed funds went vault -> router -> round
        // and were never spendable by alice.
        assertEq(token.balanceOf(alice), walletBefore, "borrowed funds passed through the wallet");
        assertEq(token.balanceOf(address(router)), 0, "router retained funds");
    }

    function test_ownFundsAndBorrowedFundsCombineIntoOnePosition() public {
        uint256 roundId = _aliceReady(1_000 ether, 400 ether);

        uint256 walletBefore = token.balanceOf(alice);
        vm.prank(alice);
        router.openPosition(roundId, ParimutuelRound.Side.Up, 200 ether, 100 ether);

        assertEq(market.stakeOf(roundId, alice, ParimutuelRound.Side.Up), 300 ether, "combined stake");
        assertEq(vault.lienOf(alice), 200 ether, "only the borrowed leg is debt");
        // Exactly the own contribution left the wallet, and nothing came back.
        assertEq(walletBefore - token.balanceOf(alice), 100 ether, "wrong amount taken from the wallet");
    }

    function test_stakingOnlyOwnFundsNeedsNoDelegation() public {
        uint256 roundId = _aliceReady(1_000 ether, 0);

        vm.prank(alice);
        router.openPosition(roundId, ParimutuelRound.Side.Up, 0, 50 ether);

        assertEq(market.stakeOf(roundId, alice, ParimutuelRound.Side.Up), 50 ether, "own-funds stake");
        assertEq(vault.lienOf(alice), 0, "no debt should exist");
    }

    // ------------------------------------------------------------------
    // Consent and limits
    // ------------------------------------------------------------------

    /// @dev Being whitelisted by the round is not consent to open someone's
    /// debt. Without an allowance the borrow leg must fail.
    function test_withoutDelegationTheRouterCannotBorrowForYou() public {
        uint256 roundId = _aliceReady(1_000 ether, 0);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralVault.InsufficientBorrowAllowance.selector, alice, address(router), 0, 100 ether
            )
        );
        router.openPosition(roundId, ParimutuelRound.Side.Up, 100 ether, 0);
    }

    function test_delegationIsBoundedAndSpentDown() public {
        uint256 roundId = _aliceReady(1_000 ether, 150 ether);

        vm.prank(alice);
        router.openPosition(roundId, ParimutuelRound.Side.Up, 100 ether, 0);
        assertEq(vault.borrowAllowance(alice, address(router)), 50 ether, "allowance not decremented");

        // The second draw exceeds what is left, even though the LTV ceiling
        // would still allow it.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralVault.InsufficientBorrowAllowance.selector, alice, address(router), 50 ether, 100 ether
            )
        );
        router.openPosition(roundId, ParimutuelRound.Side.Up, 100 ether, 0);
    }

    function test_delegationIsRevocable() public {
        uint256 roundId = _aliceReady(1_000 ether, 400 ether);

        vm.prank(alice);
        vault.approveBorrowDelegate(address(router), 0);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralVault.InsufficientBorrowAllowance.selector, alice, address(router), 0, 100 ether
            )
        );
        router.openPosition(roundId, ParimutuelRound.Side.Up, 100 ether, 0);
    }

    function test_anUnlimitedDelegationIsNotDecremented() public {
        uint256 roundId = _aliceReady(1_000 ether, type(uint256).max);

        vm.prank(alice);
        router.openPosition(roundId, ParimutuelRound.Side.Up, 100 ether, 0);

        assertEq(vault.borrowAllowance(alice, address(router)), type(uint256).max, "standing approval was spent");
    }

    /// @dev The LTV ceiling still binds. A delegation is permission to borrow,
    /// not permission to exceed the risk parameters.
    function test_theLtvCeilingStillBindsThroughTheRouter() public {
        uint256 roundId = _aliceReady(1_000 ether, type(uint256).max);

        // maxLTV is 50%, so 600 against 1,000 of collateral is too much.
        vm.prank(alice);
        vm.expectRevert();
        router.openPosition(roundId, ParimutuelRound.Side.Up, 600 ether, 0);
    }

    // ------------------------------------------------------------------
    // Atomicity
    // ------------------------------------------------------------------

    /// @dev If the position leg fails, the borrow leg must not survive it.
    /// Otherwise a user ends up with debt and nothing to show for it.
    function test_aFailedPositionLegLeavesNoDebtBehind() public {
        uint256 roundId = _aliceReady(1_000 ether, 400 ether);

        // Past the entry cutoff, so takePositionFor reverts.
        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(uint256(round.lockTime) - 5);

        vm.prank(alice);
        vm.expectRevert();
        router.openPosition(roundId, ParimutuelRound.Side.Up, 300 ether, 0);

        assertEq(vault.lienOf(alice), 0, "debt survived a failed position");
        assertEq(vault.borrowAllowance(alice, address(router)), 400 ether, "allowance was consumed");
    }

    function test_stakingNothingIsRejected() public {
        uint256 roundId = _aliceReady(1_000 ether, 400 ether);
        vm.prank(alice);
        vm.expectRevert(BorrowToPositionRouter.NothingToStake.selector);
        router.openPosition(roundId, ParimutuelRound.Side.Up, 0, 0);
    }

    // ------------------------------------------------------------------
    // Settlement — the GHO-16 rules
    // ------------------------------------------------------------------

    function test_aWinningPositionRepaysTheDebtFirstAndReturnsTheRest() public {
        uint256 roundId = _aliceReady(1_000 ether, 400 ether);

        vm.prank(alice);
        router.openPosition(roundId, ParimutuelRound.Side.Up, 300 ether, 0);
        vm.prank(carol);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 300 ether);

        uint256 walletBefore = token.balanceOf(alice);

        _resolveUp(roundId);
        uint256 payout = market.claimableOf(roundId, alice);

        // Accrued up front so the debt read here is the same one the router
        // will settle against. Reading it stale would make this assertion
        // wrong by exactly the interest, which is the bug the router itself
        // had to fix.
        pool.accrue();
        uint256 owedAtSettlement = vault.lienOf(alice);
        assertGt(payout, owedAtSettlement, "setup: the payout should exceed the debt");

        market.claim(roundId, alice);

        assertEq(vault.lienOf(alice), 0, "debt was not cleared");
        assertEq(token.balanceOf(alice) - walletBefore, payout - owedAtSettlement, "surplus not returned");
        assertEq(token.balanceOf(address(router)), 0, "router kept funds");
    }

    /// @dev Rule 2. A liquidator can clear the lien while the round is still
    /// open; the settlement must not try to repay a debt that is gone.
    function test_settlementSurvivesADebtClearedByLiquidation() public {
        uint256 roundId = _aliceReady(1_000 ether, 400 ether);

        vm.prank(alice);
        router.openPosition(roundId, ParimutuelRound.Side.Up, 300 ether, 0);
        vm.prank(carol);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 300 ether);

        // Someone repays alice's debt in full — a liquidator, or a friend.
        // The lien is hoisted: `vm.prank` applies to the next call, and an
        // inline view in the arguments is that call.
        uint256 aliceLien = vault.lienOf(alice);
        vm.prank(keeper);
        vault.repay(aliceLien, alice);
        assertEq(vault.lienOf(alice), 0, "setup: the lien should be cleared");

        uint256 walletBefore = token.balanceOf(alice);
        _resolveUp(roundId);
        uint256 payout = market.claimableOf(roundId, alice);

        // The naive router reverts here with NothingToRepay and bricks the
        // claim; this one pays it all out.
        market.claim(roundId, alice);

        assertEq(token.balanceOf(alice) - walletBefore, payout, "the whole payout should reach alice");
        assertEq(token.balanceOf(address(router)), 0, "router kept funds");
    }

    /// @dev And it is not one user's problem when it breaks, so prove the
    /// shared case too: two users funded by the same router both settle.
    function test_twoUsersOnTheSameRouterBothSettle() public {
        uint256 roundId = _aliceReady(1_000 ether, 400 ether);

        vm.prank(carol);
        vault.deposit(1_000 ether, carol);
        vm.prank(carol);
        vault.approveBorrowDelegate(address(router), 400 ether);

        vm.prank(alice);
        router.openPosition(roundId, ParimutuelRound.Side.Up, 200 ether, 0);
        vm.prank(carol);
        router.openPosition(roundId, ParimutuelRound.Side.Up, 200 ether, 0);

        vm.prank(keeper);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 100 ether);

        // Clear only alice's debt, so the two users settle down different
        // branches of onPositionSettled in the same round.
        uint256 aliceLien = vault.lienOf(alice);
        vm.prank(keeper);
        vault.repay(aliceLien, alice);

        _resolveUp(roundId);

        market.claim(roundId, alice);
        market.claim(roundId, carol);

        assertEq(vault.lienOf(carol), 0, "carol's debt should have been repaid from her payout");
        assertEq(token.balanceOf(address(router)), 0, "router kept funds");
    }

    /// @dev A losing position pays nothing, so there is no settlement call at
    /// all — and the debt stays, backed by collateral.
    function test_aLosingPositionLeavesTheDebtStanding() public {
        uint256 roundId = _aliceReady(1_000 ether, 400 ether);

        vm.prank(alice);
        router.openPosition(roundId, ParimutuelRound.Side.Up, 300 ether, 0);
        vm.prank(carol);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 300 ether);

        uint256 lienBefore = vault.lienOf(alice);
        _resolveDown(roundId);

        assertEq(market.claimableOf(roundId, alice), 0, "a loser should have nothing to claim");
        assertEq(vault.lienOf(alice), lienBefore, "the debt should still stand");
        assertTrue(vault.healthFactor(alice) > 0, "the position is still collateralised");
    }

    /// @dev A void round refunds the stake, which settles the same way as a
    /// win: debt first, remainder to the user.
    function test_aVoidRoundRefundsThroughTheSameSettlementPath() public {
        uint256 roundId = _aliceReady(1_000 ether, 400 ether);

        vm.prank(alice);
        router.openPosition(roundId, ParimutuelRound.Side.Up, 300 ether, 0);

        // No opposing side, so the round voids at lock.
        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(round.lockTime);
        market.lockRound(roundId);
        assertEq(uint256(market.phaseOf(roundId)), uint256(ParimutuelRound.Phase.Void), "round should have voided");

        uint256 refund = market.claimableOf(roundId, alice);
        pool.accrue();
        uint256 owedAtSettlement = vault.lienOf(alice);

        market.claim(roundId, alice);

        // The refund is the stake back — the principal, and not a penny more.
        // Interest accrued while the round was open is still owed, so a void
        // leaves exactly that behind rather than clearing the debt. Correct,
        // and worth pinning: the user borrowed and paid for the time.
        assertEq(refund, 300 ether, "a void should refund the stake");
        assertEq(vault.lienOf(alice), owedAtSettlement - refund, "the debt should fall by exactly the refund");
        assertGt(vault.lienOf(alice), 0, "the accrued interest is still owed");
        assertEq(token.balanceOf(address(router)), 0, "router kept funds");
    }

    // ------------------------------------------------------------------
    // The settlement hook itself
    // ------------------------------------------------------------------

    /// @dev Anyone calling in could otherwise make this contract spend its
    /// balance repaying a debt nobody asked it to.
    function test_onlyTheMarketMaySettle() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BorrowToPositionRouter.OnlyMarket.selector, alice));
        router.onPositionSettled(alice, 1 ether);
    }

    /// @dev A user who has entered through the router cannot also enter the
    /// same round directly: the round refuses a stake that mixes a settlement
    /// sink with unsinked funds. Documented here because it is a real user
    /// path, and the revert is otherwise cryptic.
    function test_enteringTheSameRoundDirectlyAfterTheRouterIsRefused() public {
        uint256 roundId = _aliceReady(1_000 ether, 400 ether);

        vm.prank(alice);
        router.openPosition(roundId, ParimutuelRound.Side.Up, 200 ether, 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.MixedFunding.selector, roundId, alice));
        market.takePosition(roundId, ParimutuelRound.Side.Up, 10 ether);
    }

    /// @dev Two positions in different rounds settle independently. This is
    /// what makes any per-user principal tally inside the router wrong, and
    /// why it does not keep one.
    function test_positionsInTwoRoundsSettleIndependently() public {
        uint256 first = _aliceReady(2_000 ether, 800 ether);

        vm.prank(owner);
        uint256 second = market.openRound(
            uint64(block.timestamp), uint64(block.timestamp + 10 minutes), uint64(block.timestamp + 20 minutes)
        );

        vm.prank(alice);
        router.openPosition(first, ParimutuelRound.Side.Up, 200 ether, 0);
        vm.prank(alice);
        router.openPosition(second, ParimutuelRound.Side.Up, 200 ether, 0);
        assertEq(vault.lienOf(alice), 400 ether, "both borrows should be owed");

        vm.prank(carol);
        market.takePosition(first, ParimutuelRound.Side.Down, 200 ether);
        vm.prank(carol);
        market.takePosition(second, ParimutuelRound.Side.Down, 200 ether);

        _resolveUp(first);
        market.claim(first, alice);

        // The first settlement repaid what it could; the second round's debt
        // is untouched and still owed.
        assertGt(vault.lienOf(alice), 0, "the second round's debt should still stand");
        assertEq(token.balanceOf(address(router)), 0, "router kept funds");
    }

    function test_theRouterRefusesAMismatchedAssetPair() public {
        ERC20Mock other = new ERC20Mock();
        ParimutuelRound otherMarket = new ParimutuelRound(
            IERC20(address(other)),
            IRoundOracle(address(oracle)),
            2e16,
            ParimutuelRound.Timing({ entryCutoff: 15, lockWindow: 60, resolveDeadline: 1 hours }),
            1 ether,
            owner,
            owner
        );

        vm.expectRevert(BorrowToPositionRouter.AssetMismatch.selector);
        new BorrowToPositionRouter(vault, otherMarket);
    }
}
