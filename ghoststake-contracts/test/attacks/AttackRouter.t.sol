// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { BorrowLiquidityPool } from "../../src/BorrowLiquidityPool.sol";
import { BorrowToPositionRouter } from "../../src/BorrowToPositionRouter.sol";
import { CollateralVault, ILienSource } from "../../src/CollateralVault.sol";
import { ParimutuelRound, IRoundOracle } from "../../src/ParimutuelRound.sol";
import { MockRoundOracle } from "../mocks/MockRoundOracle.sol";

/// @notice Adversarial suite against the borrow-to-position router — the
/// newest and least-exercised contract in the stack, and the one place where
/// the lending side and the market side can reach each other.
///
/// Two questions dominate: can this contract be made to manufacture debt for
/// someone who never agreed to any, and can a settlement be made to revert
/// (which strands every payout it funded, permanently, because the round has
/// no fallback path).
contract AttackRouterTest is Test {
    uint256 internal constant YEAR = 365 days;

    BorrowLiquidityPool internal pool;
    CollateralVault internal vault;
    ParimutuelRound internal market;
    BorrowToPositionRouter internal router;
    MockRoundOracle internal oracle;
    ERC20Mock internal token;

    address internal owner = makeAddr("owner");
    address internal lender = makeAddr("lender");
    address internal alice = makeAddr("alice");
    address internal mallory = makeAddr("mallory");
    address internal victim = makeAddr("victim");

    function setUp() public {
        vm.warp(1_700_000_000);
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

        oracle = new MockRoundOracle(2000e18);
        market = new ParimutuelRound(
            IERC20(address(token)),
            IRoundOracle(address(oracle)),
            2e16,
            ParimutuelRound.Timing({ entryCutoff: 15, lockWindow: 60, resolveDeadline: 1 hours }),
            1 ether,
            owner
        );
        router = new BorrowToPositionRouter(vault, market);
        vm.prank(owner);
        market.setRouter(address(router), true);

        address[4] memory users = [alice, mallory, victim, lender];
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

    function _openRound() internal returns (uint256 id) {
        vm.prank(owner);
        id = market.openRound(
            uint64(block.timestamp), uint64(block.timestamp + 10 minutes), uint64(block.timestamp + 20 minutes)
        );
    }

    function _ready(address user, uint256 deposit, uint256 allowance) internal {
        vm.prank(user);
        vault.deposit(deposit, user);
        vm.prank(user);
        vault.approveBorrowDelegate(address(router), allowance);
    }

    function _resolveUp(uint256 id) internal {
        ParimutuelRound.Round memory round = market.rounds(id);
        vm.warp(round.lockTime);
        market.lockRound(id);
        oracle.setPrice(2100e18);
        uint80 closeRound = oracle.oracleRoundId();
        vm.warp(uint256(round.closeTime) + 1);
        market.resolveRound(id, closeRound);
    }

    // ================================================================
    // S. Router
    // ================================================================

    /// @dev S1 — being whitelisted by the round is not consent to open
    /// someone's debt. Without a delegation the borrow leg must fail, so a
    /// compromise here cannot manufacture liabilities.
    function test_S1_cannotOpenAPositionOnBorrowedFundsWithoutADelegation() public {
        _ready(victim, 1_000 ether, 0);
        uint256 id = _openRound();

        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralVault.InsufficientBorrowAllowance.selector, victim, address(router), 0, 100 ether
            )
        );
        vm.prank(victim);
        router.openPosition(id, ParimutuelRound.Side.Up, 100 ether, 0);
    }

    /// @dev S2 — the router only ever borrows for `msg.sender`, so there is
    /// no argument an attacker can pass that puts the debt on someone else.
    /// Even with a standing delegation in place, Mallory cannot spend it.
    function test_S2_astandingDelegationCannotBeSpentByAThirdParty() public {
        _ready(victim, 1_000 ether, type(uint256).max);
        uint256 id = _openRound();

        vm.prank(mallory);
        vm.expectRevert(); // Mallory has no collateral of her own to draw on
        router.openPosition(id, ParimutuelRound.Side.Up, 100 ether, 0);

        assertEq(vault.lienOf(victim), 0, "the victim's delegation was untouched");
    }

    /// @dev S3 — the settlement callback is the round's only outward call. If
    /// anyone could invoke it, they could make this contract spend its
    /// balance repaying a debt nobody asked it to.
    function test_S3_onlyTheMarketCanDeclareASettlement() public {
        vm.expectRevert(abi.encodeWithSelector(BorrowToPositionRouter.OnlyMarket.selector, mallory));
        vm.prank(mallory);
        router.onPositionSettled(victim, 100 ether);
    }

    /// @dev S4 — the stranding case that matters most: a liquidator clears
    /// the lien while the position is still open, so by settlement time there
    /// is nothing to repay. `CollateralVault.repay` reverts on a cleared
    /// lien, and a reverting sink strands every payout it funded, for
    /// everyone, permanently.
    function test_S4_settlementSurvivesALienClearedBeforeItLands() public {
        _ready(alice, 1_000 ether, type(uint256).max);
        uint256 id = _openRound();

        vm.prank(alice);
        router.openPosition(id, ParimutuelRound.Side.Up, 400 ether, 0);
        vm.prank(mallory);
        market.takePosition(id, ParimutuelRound.Side.Down, 400 ether);

        // Alice clears her own lien from her wallet before the round settles.
        uint256 owed = vault.lienOf(alice);
        vm.prank(alice);
        vault.repay(owed, alice);
        assertEq(vault.lienOf(alice), 0, "precondition: nothing left to repay");

        _resolveUp(id);

        uint256 walletBefore = token.balanceOf(alice);
        uint256 payout = market.claim(id, alice);

        assertGt(payout, 0, "the payout must not be stranded");
        assertEq(token.balanceOf(alice) - walletBefore, payout, "it is forwarded to the user in full");
        assertEq(token.balanceOf(address(router)), 0, "nothing left behind in the router");
    }

    /// @dev S5 — the mirror: a payout larger than the lien must repay the
    /// debt and forward the rest, rather than over-repaying or holding on.
    function test_S5_surplusIsForwardedAndTheLienIsClearedExactly() public {
        _ready(alice, 1_000 ether, type(uint256).max);
        uint256 id = _openRound();

        vm.prank(alice);
        router.openPosition(id, ParimutuelRound.Side.Up, 100 ether, 0);
        vm.prank(mallory);
        market.takePosition(id, ParimutuelRound.Side.Down, 400 ether);

        _resolveUp(id);
        uint256 walletBefore = token.balanceOf(alice);
        uint256 payout = market.claim(id, alice);

        assertGt(payout, 100 ether, "precondition: the payout exceeds the debt");
        assertEq(vault.lienOf(alice), 0, "the lien is cleared exactly");
        // Slightly less than `payout - 100 ether`: the lien accrued interest
        // for the life of the round, and that interest is repaid too.
        assertApproxEqRel(
            token.balanceOf(alice) - walletBefore, payout - 100 ether, 1e15, "the surplus reaches the user"
        );
        assertLt(token.balanceOf(alice) - walletBefore, payout - 100 ether, "interest was paid out of it");
        assertEq(token.balanceOf(address(router)), 0, "nothing left behind in the router");
    }

    /// @dev S6 — a settlement must not leave a live allowance behind. A
    /// residual approval on the vault or the market is a standing licence to
    /// pull from this contract.
    function test_S6_noResidualAllowancesSurviveASettlement() public {
        _ready(alice, 1_000 ether, type(uint256).max);
        uint256 id = _openRound();

        vm.prank(alice);
        router.openPosition(id, ParimutuelRound.Side.Up, 100 ether, 0);
        vm.prank(mallory);
        market.takePosition(id, ParimutuelRound.Side.Down, 400 ether);
        _resolveUp(id);
        market.claim(id, alice);

        assertEq(token.allowance(address(router), address(market)), 0, "no standing approval to the market");
        assertEq(token.allowance(address(router), address(vault)), 0, "no standing approval to the vault");
    }

    /// @dev S7 — donate to the router and then try to stake the donation.
    /// `openPosition` must stake only what it actually received.
    function test_S7_donatedFundsCannotBeStakedByAnotherUser() public {
        vm.prank(mallory);
        token.transfer(address(router), 10_000 ether);

        _ready(alice, 1_000 ether, type(uint256).max);
        uint256 id = _openRound();

        vm.prank(alice);
        router.openPosition(id, ParimutuelRound.Side.Up, 100 ether, 0);

        assertEq(market.stakeOf(id, alice, ParimutuelRound.Side.Up), 100 ether, "staked exactly what was drawn");
        assertEq(token.balanceOf(address(router)), 10_000 ether, "the donation is untouched, not stakeable");
    }

    /// @dev S8 — a losing position must leave the debt intact rather than
    /// quietly forgiving it. Nothing settles, so nothing is repaid.
    function test_S8_aLosingPositionLeavesTheDebtStanding() public {
        _ready(alice, 1_000 ether, type(uint256).max);
        uint256 id = _openRound();

        vm.prank(alice);
        router.openPosition(id, ParimutuelRound.Side.Down, 400 ether, 0);
        vm.prank(mallory);
        market.takePosition(id, ParimutuelRound.Side.Up, 400 ether);

        _resolveUp(id);

        vm.expectRevert();
        market.claim(id, alice);
        assertEq(vault.lienOf(alice), 400 ether, "the borrower still owes what they borrowed");
    }

    /// @dev S9 — a refunded (void) round must return the borrowed stake to
    /// the debt it came from, not to the borrower's wallet.
    function test_S9_aVoidRoundRefundRepaysTheDebtRatherThanThePocket() public {
        _ready(alice, 1_000 ether, type(uint256).max);
        uint256 id = _openRound();

        vm.prank(alice);
        router.openPosition(id, ParimutuelRound.Side.Up, 400 ether, 0);
        // Only one side fills, so the round voids at lock.
        ParimutuelRound.Round memory round = market.rounds(id);
        vm.warp(round.lockTime);
        market.lockRound(id);
        assertEq(uint256(market.phaseOf(id)), uint256(ParimutuelRound.Phase.Void), "precondition: voided");

        uint256 walletBefore = token.balanceOf(alice);
        market.claim(id, alice);

        // The refund is the stake, not the stake plus interest, so what
        // survives is exactly the interest for the life of the round — the
        // borrower is not forgiven the cost of having held the loan.
        uint256 residual = vault.lienOf(alice);
        assertLt(residual, 0.001 ether, "only accrued interest survives the refund");
        assertGt(residual, 0, "and the interest is genuinely still owed");
        assertEq(token.balanceOf(alice), walletBefore, "none of the refund leaked into the wallet");
    }

    /// @dev X6 — THE ROUTER SEIZES WINNINGS FOR AN UNRELATED DEBT. The
    /// settlement sink is set per round, not per funding source, so a user who
    /// stakes entirely their OWN money through `openPosition` still has the
    /// whole payout routed into repaying a lien they opened separately. No
    /// funds are lost — the debt really does shrink, and the surplus is
    /// forwarded — but the user does not choose it, and cannot be paid in
    /// cash while any lien is open.
    function test_X6_selfFundedWinningsAreDivertedToAnUnrelatedLien() public {
        _ready(alice, 1_000 ether, type(uint256).max);

        // A lien opened directly, nothing to do with any round.
        vm.prank(alice);
        vault.borrow(400 ether);
        uint256 lienBefore = vault.lienOf(alice);

        uint256 id = _openRound();
        // Entirely her own money: borrowAmount is zero.
        vm.prank(alice);
        router.openPosition(id, ParimutuelRound.Side.Up, 0, 100 ether);
        vm.prank(mallory);
        market.takePosition(id, ParimutuelRound.Side.Down, 400 ether);

        _resolveUp(id);
        uint256 walletBefore = token.balanceOf(alice);
        uint256 payout = market.claim(id, alice);

        assertGt(payout, 0, "she won");
        // The payout is applied to the unrelated lien first; only what the
        // debt could not absorb reaches her. She staked her own money and
        // still cannot choose to be paid in cash while any lien is open.
        assertEq(vault.lienOf(alice), 0, "the unrelated lien was cleared out of her winnings");
        assertApproxEqAbs(
            token.balanceOf(alice) - walletBefore, payout - lienBefore, 1e15, "she receives only the surplus"
        );
        emit log_named_uint("payout (wei)", payout);
        emit log_named_uint("diverted to the unrelated lien (wei)", lienBefore);
        emit log_named_uint("reached her wallet (wei)", token.balanceOf(alice) - walletBefore);
    }
}
