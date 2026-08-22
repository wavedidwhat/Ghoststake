// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CollateralVault, ILienSource } from "../src/CollateralVault.sol";

/// @notice Regression tests for the ledger-integrity findings from the
/// security review of GHO-6/GHO-7. Each test here corresponds to a specific
/// finding and failed against the pre-fix contract.
///
/// The invariant all of these defend: `positions[user]` must stay
/// proportional to `balanceOf(user)`. A user with zero shares must have a
/// zero position, and moving shares must move the ledger with them —
/// otherwise the ledger can be forked from reality and (once GHO-8 reads it
/// as collateral value) borrowed against.
contract LedgerIntegrityTest is Test {
    // 5% APR as a per-second WAD rate. Nonzero on purpose: the pre-existing
    // CollateralVault.t.sol runs at rate 0, which structurally cannot
    // surface any of the bugs below.
    uint256 internal constant FIVE_PERCENT_APR = uint256(5e16) / 365 days;

    CollateralVault internal vault;
    ERC20Mock internal token;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new ERC20Mock();
        vault = new CollateralVault(IERC20(address(token)), FIVE_PERCENT_APR, ILienSource(address(0)));

        token.mint(alice, 1_000_000 ether);
        token.mint(bob, 1_000_000 ether);

        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);
    }

    function _totalLedgerValue(address user) internal view returns (uint256) {
        (uint256 principal,,, uint256 settledYield) = vault.positions(user);
        return principal + settledYield + vault.accruedYield(user);
    }

    // ---------------------------------------------------------------
    // Finding 2: full exit at a nonzero rate left a compounding residue
    // ---------------------------------------------------------------

    /// @dev The test the old suite was missing entirely: nonzero rate AND a
    /// full exit. CollateralVault.t.sol asserts this same invariant but at
    /// rate 0, where it cannot fail.
    function test_fullExitAtNonzeroRateLeavesNothingBehind() public {
        vm.startPrank(alice);
        uint256 shares = vault.deposit(1_000 ether, alice);
        vm.warp(block.timestamp + 365 days);
        vault.redeem(shares, alice, alice);
        vm.stopPrank();

        assertEq(vault.balanceOf(alice), 0, "no shares left");
        assertEq(_totalLedgerValue(alice), 0, "no ledger value may survive a full exit");
    }

    function test_fullExitViaWithdrawAlsoLeavesNothingBehind() public {
        vm.startPrank(alice);
        vault.deposit(1_000 ether, alice);
        vm.warp(block.timestamp + 365 days);
        vault.withdraw(vault.maxWithdraw(alice), alice, alice);
        vm.stopPrank();

        assertEq(vault.balanceOf(alice), 0, "no shares left");
        assertEq(_totalLedgerValue(alice), 0, "no ledger value may survive a full exit");
    }

    /// @dev The residue was self-compounding: it kept accruing forever on an
    /// address with no stake. Confirms it cannot come back from the dead.
    function test_exitedPositionDoesNotAccrueAfterwards() public {
        vm.startPrank(alice);
        uint256 shares = vault.deposit(1_000 ether, alice);
        vm.warp(block.timestamp + 365 days);
        vault.redeem(shares, alice, alice);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days * 10);
        vault.settle(alice);

        assertEq(_totalLedgerValue(alice), 0, "an exited position must never accrue again");
    }

    // ---------------------------------------------------------------
    // Finding 1: share transfers desynced the ledger
    // ---------------------------------------------------------------

    /// @dev The core exploit: deposit from A, move shares to B, exit from B,
    /// and A keeps a full phantom position. Repeat to mint unlimited
    /// collateral records from fixed capital.
    function test_transferThenExitDoesNotStrandPhantomLedgerValue() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000 ether, alice);

        vm.prank(alice);
        vault.transfer(bob, shares);

        vm.prank(bob);
        vault.redeem(shares, bob, bob);

        assertEq(_totalLedgerValue(alice), 0, "alice kept phantom ledger value after handing off her shares");
        assertEq(_totalLedgerValue(bob), 0, "bob fully exited, nothing should remain");
    }

    function test_transferMovesLedgerValueWithTheShares() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000 ether, alice);

        vm.prank(alice);
        vault.transfer(bob, shares);

        assertEq(_totalLedgerValue(alice), 0, "sender keeps nothing after sending all shares");
        assertApproxEqAbs(_totalLedgerValue(bob), 1_000 ether, 1, "receiver gains the ledger value");
    }

    function test_partialTransferSplitsLedgerValueProRata() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000 ether, alice);

        vm.prank(alice);
        vault.transfer(bob, shares / 4);

        assertApproxEqAbs(_totalLedgerValue(alice), 750 ether, 1e12, "sender keeps 75%");
        assertApproxEqAbs(_totalLedgerValue(bob), 250 ether, 1e12, "receiver gets 25%");
    }

    /// @dev Transferring must not silently discard yield the sender earned
    /// before the transfer.
    function test_transferAfterAccrualPreservesTotalLedgerValue() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000 ether, alice);
        vm.warp(block.timestamp + 365 days);

        uint256 totalBefore = _totalLedgerValue(alice);
        assertGt(totalBefore, 1_000 ether, "yield actually accrued");

        vm.prank(alice);
        vault.transfer(bob, shares);

        assertApproxEqAbs(
            _totalLedgerValue(alice) + _totalLedgerValue(bob), totalBefore, 1e6, "transfer must conserve ledger value"
        );
    }

    // ---------------------------------------------------------------
    // Finding 3: yield was path-dependent (grindable via settle())
    // ---------------------------------------------------------------

    /// @dev The grind: settle() is free and permissionless, and folding
    /// yield into the accrual base made frequent settling pay. Two identical
    /// deposits must end identically regardless of settle cadence.
    function test_yieldIsIndependentOfSettleCadence() public {
        vm.prank(alice);
        vault.deposit(1_000_000 ether, alice);
        vm.prank(bob);
        vault.deposit(1_000_000 ether, bob);

        // Alice grinds settle daily for a year; Bob never settles.
        for (uint256 i = 0; i < 365; i++) {
            vm.warp(block.timestamp + 1 days);
            vault.settle(alice);
        }

        assertEq(
            _totalLedgerValue(alice), _totalLedgerValue(bob), "settle cadence must not change how much yield is earned"
        );
    }

    function testFuzz_yieldIsIndependentOfSettleCadence(uint8 settleCount) public {
        vm.assume(settleCount > 0);

        vm.prank(alice);
        vault.deposit(500_000 ether, alice);
        vm.prank(bob);
        vault.deposit(500_000 ether, bob);

        uint256 start = block.timestamp;
        uint256 step = uint256(360 days) / settleCount;

        for (uint256 i = 0; i < settleCount; i++) {
            vm.warp(start + step * (i + 1));
            vault.settle(alice);
        }

        // Land both at exactly the same final timestamp before comparing.
        vm.warp(start + 360 days);
        assertEq(_totalLedgerValue(alice), _totalLedgerValue(bob), "yield must be a function of stake x time only");
    }

    /// @dev Anyone can settle anyone. That must stay harmless — it must not
    /// become a lever to inflate (or deflate) a victim's position, which
    /// would matter once GHO-9 liquidation reads health factors.
    function test_thirdPartySettleCannotChangeAnothersTotalValue() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        vm.warp(block.timestamp + 180 days);

        uint256 before = _totalLedgerValue(alice);
        vm.prank(bob);
        vault.settle(alice);

        assertEq(_totalLedgerValue(alice), before, "a third-party settle must be value-neutral");
    }

    // ---------------------------------------------------------------
    // Unbacked yield must never become spendable collateral
    // ---------------------------------------------------------------

    /// @dev Nothing funds the yield, so ledger value drifts above what the
    /// vault can actually pay. `collateralValue` is the capped number GHO-8
    /// must lend against; raw ledger value is not.
    function test_collateralValueIsCappedAtWhatTheVaultCanActuallyPay() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        vm.warp(block.timestamp + 365 days);

        uint256 redeemable = vault.convertToAssets(vault.balanceOf(alice));
        assertGt(vault.totalLedgerValue(alice), redeemable, "ledger has drifted above real backing, as expected");
        assertEq(vault.collateralValue(alice), redeemable, "collateral value must be capped at real backing");
    }

    function test_collateralValueIsZeroAfterFullExit() public {
        vm.startPrank(alice);
        uint256 shares = vault.deposit(1_000 ether, alice);
        vm.warp(block.timestamp + 365 days);
        vault.redeem(shares, alice, alice);
        vm.stopPrank();

        assertEq(vault.collateralValue(alice), 0);
    }

    function testFuzz_collateralValueNeverExceedsRedeemableAssets(uint96 amount, uint32 elapsed) public {
        vm.assume(amount > 1e6);
        token.mint(alice, amount);

        vm.startPrank(alice);
        token.approve(address(vault), amount);
        vault.deposit(amount, alice);
        vm.stopPrank();

        vm.warp(block.timestamp + elapsed);

        assertLe(
            vault.collateralValue(alice),
            vault.convertToAssets(vault.balanceOf(alice)),
            "collateral value must never exceed what the shares can redeem for"
        );
    }

    /// @dev Transferring from an address with no shares must surface ERC20's
    /// own error, not a division panic from the ledger bookkeeping.
    function test_transferFromEmptyAddressRevertsCleanly() public {
        vm.prank(bob);
        vm.expectRevert();
        vault.transfer(alice, 1 ether);
    }

    // ---------------------------------------------------------------
    // The umbrella invariant
    // ---------------------------------------------------------------

    /// @dev Ledger value must never exceed what the vault could actually pay
    /// the user for their shares plus yield claims. Catches the whole class.
    function testFuzz_zeroSharesImpliesZeroLedger(uint96 amount, uint32 elapsed) public {
        vm.assume(amount > 1e6);
        token.mint(alice, amount);

        vm.startPrank(alice);
        token.approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, alice);
        vm.warp(block.timestamp + elapsed);
        vault.redeem(shares, alice, alice);
        vm.stopPrank();

        assertEq(vault.balanceOf(alice), 0);
        assertEq(_totalLedgerValue(alice), 0, "zero shares must always mean zero ledger value");
    }
}
