// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { AttackHarness } from "./AttackHarness.sol";
import { CollateralVault } from "../../src/CollateralVault.sol";

/// @notice Adversarial suite against CollateralVault. Each test *tries* the
/// attack and asserts the defence, so a regression that opens the hole turns
/// the test red rather than leaving it silently passing.
///
/// Attack classes drawn from the ERC-4626 inflation/donation literature
/// (OpenZeppelin, Euler, MixBytes), the Solodit/Cyfrin lending checklist, and
/// the Decurity CDP vulnerability taxonomy.
contract AttackVaultTest is AttackHarness {
    function setUp() public {
        _deployStack();
    }

    // ================================================================
    // A. ERC-4626 share-price attacks
    // ================================================================

    /// @dev A1 — classic first-depositor inflation. Mallory seeds 1 wei, then
    /// donates to move the share price so a later depositor mints zero shares
    /// and their assets become Mallory's.
    function test_A1_firstDepositorInflationAttack() public {
        vm.prank(mallory);
        vault.deposit(1, mallory);

        // The donation: raise totalAssets without minting shares.
        vm.prank(mallory);
        token.transfer(address(vault), 10_000 ether);

        uint256 victimDeposit = 1_000 ether;
        vm.prank(victim);
        vault.deposit(victimDeposit, victim);

        uint256 victimShares = vault.balanceOf(victim);
        assertGt(victimShares, 0, "victim must not be rounded to zero shares");

        // Mallory unwinds everything she can.
        uint256 mShares = vault.balanceOf(mallory);
        vm.prank(mallory);
        vault.redeem(mShares, mallory, mallory);

        // She cannot end up ahead: the 6-decimal virtual offset makes the
        // donation cost more than it can ever capture.
        assertLt(token.balanceOf(mallory), 1_000_000 ether, "inflation attack must be loss-making for the attacker");
        assertGe(
            vault.convertToAssets(victimShares),
            victimDeposit * 999 / 1000,
            "victim keeps essentially all of their deposit"
        );
    }

    /// @dev A2 — donate to the vault to inflate everyone's `convertToAssets`,
    /// then borrow against the inflated collateral value and walk away.
    function test_A2_donationCannotBuyBorrowCapacityWorthMoreThanTheDonation() public {
        _deposit(mallory, 1_000 ether);
        uint256 before = vault.maxBorrowable(mallory);

        vm.prank(mallory);
        token.transfer(address(vault), 100_000 ether);

        uint256 afterDonation = vault.maxBorrowable(mallory);
        assertLe(afterDonation - before, 100_000 ether, "a donation can never buy more borrow capacity than it cost");

        // And with a second holder present the donation is mostly a gift.
        _deposit(alice, 1_000 ether);
        assertGt(vault.maxBorrowable(alice), 0, "the donation leaks to other holders");
    }

    /// @dev A3 — the unfunded-yield question. `settledYield` is a claim on
    /// assets that do not exist; if it fed borrow capacity uncapped, the pool
    /// would be lending against nothing.
    function test_A3_unfundedYieldIsNeverBorrowable() public {
        _deposit(mallory, 1_000 ether);
        vm.warp(block.timestamp + 10 * YEAR);
        vault.settle(mallory);

        uint256 ledger = vault.totalLedgerValue(mallory);
        uint256 real = vault.convertToAssets(vault.balanceOf(mallory));
        assertGt(ledger, real, "precondition: the ledger claims more than exists");

        assertEq(vault.collateralValue(mallory), real, "collateral value is capped at real assets");
        assertLe(vault.maxBorrowable(mallory), real * MAX_LTV / WAD, "capacity follows real assets, not the ledger");
    }

    /// @dev A4 — grind `settle()`. It is free and permissionless; if yield
    /// compounded, calling it every block would print value from nothing.
    function test_A4_settleGrindingEarnsNothing() public {
        _deposit(alice, 1_000 ether);
        _deposit(mallory, 1_000 ether);

        uint256 start = block.timestamp;
        for (uint256 i = 0; i < 365; i++) {
            vm.warp(start + (i + 1) * 1 days);
            vault.settle(mallory); // Mallory grinds daily; Alice never settles.
        }
        vault.settle(alice);

        assertEq(
            vault.totalLedgerValue(mallory),
            vault.totalLedgerValue(alice),
            "yield must be a pure function of stake x time"
        );
    }

    // ================================================================
    // B. Escaping a lien
    // ================================================================

    /// @dev B1 — hand the collateral to a clean address and leave the debt
    /// stranded on an empty one.
    function test_B1_cannotTransferSharesAwayFromAnOpenLien() public {
        _deposit(mallory, 1_000 ether);
        _borrow(mallory, 400 ether);

        uint256 shares = vault.balanceOf(mallory);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.LienOutstanding.selector, mallory, 400 ether));
        vm.prank(mallory);
        vault.transfer(bob, shares);
    }

    /// @dev B1b — the same escape via an ERC-20 allowance and a third party.
    function test_B1b_cannotTransferFromAwayFromAnOpenLien() public {
        _deposit(mallory, 1_000 ether);
        _borrow(mallory, 400 ether);

        vm.prank(mallory);
        vault.approve(bob, type(uint256).max);

        uint256 shares = vault.balanceOf(mallory);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.LienOutstanding.selector, mallory, 400 ether));
        vm.prank(bob);
        vault.transferFrom(mallory, bob, shares);
    }

    /// @dev B2 — salami-slice the collateral out one withdrawal at a time,
    /// each individually too small to trip a check.
    function test_B2_cannotPartiallyWithdrawWithALienOpen() public {
        _deposit(mallory, 1_000 ether);
        _borrow(mallory, 400 ether);

        vm.expectRevert(
            abi.encodeWithSelector(
                CollateralVault.PartialExitWithLienOpen.selector,
                vault.previewWithdraw(1 ether),
                vault.balanceOf(mallory)
            )
        );
        vm.prank(mallory);
        vault.withdraw(1 ether, mallory, mallory);
    }

    /// @dev B3 — a full exit is allowed, but the creditor is paid first.
    function test_B3_fullExitPaysTheLienBeforeTheUser() public {
        _deposit(mallory, 1_000 ether);
        _borrow(mallory, 400 ether);
        uint256 walletBefore = token.balanceOf(mallory);
        uint256 lien = vault.lienOf(mallory);

        uint256 shares = vault.balanceOf(mallory);
        vm.prank(mallory);
        vault.redeem(shares, mallory, mallory);

        assertEq(vault.lienOf(mallory), 0, "debt cleared on the way out");
        assertApproxEqAbs(token.balanceOf(mallory) - walletBefore, 1_000 ether - lien, 1, "user keeps only the residue");
    }

    /// @dev B4 — an underwater borrower must not be able to exit at all: the
    /// collateral no longer covers the lien, so an exit would hand the loss
    /// to the pool.
    function test_B4_underwaterBorrowerCannotExitAndStrandTheLoss() public {
        _deposit(mallory, 1_000 ether);
        _borrow(mallory, 500 ether);

        // Let interest run until the lien exceeds the collateral outright.
        vm.warp(block.timestamp + 200 * YEAR);
        pool.accrue();
        assertGt(vault.lienOf(mallory), vault.convertToAssets(vault.balanceOf(mallory)), "precondition: underwater");

        uint256 shares = vault.balanceOf(mallory);
        vm.expectRevert();
        vm.prank(mallory);
        vault.redeem(shares, mallory, mallory);
    }

    // ================================================================
    // C. Borrow authorisation
    // ================================================================

    /// @dev C1 — manufacture debt on an account that never agreed to any.
    function test_C1_cannotBorrowAgainstSomeoneElsesCollateral() public {
        _deposit(victim, 1_000 ether);

        vm.expectRevert(
            abi.encodeWithSelector(CollateralVault.InsufficientBorrowAllowance.selector, victim, mallory, 0, 100 ether)
        );
        vm.prank(mallory);
        vault.borrowFor(victim, 100 ether);
    }

    /// @dev C2 — a bounded credit line must stay bounded, and must not be
    /// redirectable to an address of the delegate's choosing.
    function test_C2_delegatedBorrowIsBoundedAndPaysOnlyTheDelegate() public {
        _deposit(victim, 1_000 ether);
        vm.prank(victim);
        vault.approveBorrowDelegate(mallory, 100 ether);

        vm.prank(mallory);
        vault.borrowFor(victim, 100 ether);
        assertEq(token.balanceOf(mallory) - 1_000_000 ether, 100 ether, "proceeds go to the delegate, as designed");

        vm.expectRevert();
        vm.prank(mallory);
        vault.borrowFor(victim, 1);
        assertEq(vault.borrowAllowance(victim, mallory), 0, "allowance is consumed exactly once");
    }

    /// @dev C3 — the pool is the money. Anything that is not the borrow
    /// module must not be able to create debt against it.
    function test_C3_poolRefusesBorrowsFromAnyoneButTheModule() public {
        vm.expectRevert();
        vm.prank(mallory);
        pool.borrow(1_000 ether, mallory);
    }

    /// @dev C4 — repoint the borrow module at a contract of the attacker's
    /// choosing. This is the one owner key that could drain the pool outright.
    function test_C4_borrowModuleCannotBeRepointed() public {
        vm.expectRevert();
        vm.prank(owner);
        pool.setBorrowModule(mallory);
    }

    /// @dev C5 — borrow past the LTV ceiling in one step, or by stacking
    /// several draws that are each individually within it.
    function test_C5_stackedBorrowsCannotExceedTheLTVCeiling() public {
        _deposit(mallory, 1_000 ether);
        for (uint256 i = 0; i < 10; i++) {
            uint256 room = vault.maxBorrowable(mallory);
            if (room == 0) break;
            _borrow(mallory, room);
        }
        uint256 ceiling = vault.collateralValue(mallory) * MAX_LTV / WAD;
        assertLe(vault.lienOf(mallory), ceiling, "the ceiling holds across repeated draws");
        assertGe(vault.healthFactor(mallory), WAD, "a fresh borrow is never born liquidatable");
    }
}
