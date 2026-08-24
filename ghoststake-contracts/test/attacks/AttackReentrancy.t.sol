// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CollateralVault, ILienSource } from "../../src/CollateralVault.sol";
import { BorrowLiquidityPool } from "../../src/BorrowLiquidityPool.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { HookedToken } from "./HookedToken.sol";

/// @notice The reentrant attacker. Whatever `action` is set to, it is
/// attempted from inside a token transfer the protocol is in the middle of.
contract Reenterer {
    CollateralVault public vault;
    BorrowLiquidityPool public pool;
    HookedToken public token;

    enum Action {
        None,
        Borrow,
        Withdraw,
        Deposit,
        Settle,
        Liquidate,
        PoolWithdraw
    }

    Action public action;
    bool public reentered;
    bool public innerSucceeded;

    constructor(CollateralVault vault_, BorrowLiquidityPool pool_, HookedToken token_) {
        vault = vault_;
        pool = pool_;
        token = token_;
        token_.approve(address(vault_), type(uint256).max);
        token_.approve(address(pool_), type(uint256).max);
    }

    function set(Action a) external {
        action = a;
        reentered = false;
        innerSucceeded = false;
    }

    function tokensReceived() external {
        if (action == Action.None) return;
        reentered = true;
        if (action == Action.Borrow) {
            vault.borrow(1 ether);
        } else if (action == Action.Withdraw) {
            vault.redeem(vault.balanceOf(address(this)), address(this), address(this));
        } else if (action == Action.Deposit) {
            vault.deposit(1 ether, address(this));
        } else if (action == Action.Settle) {
            vault.settle(address(this));
        } else if (action == Action.PoolWithdraw) {
            pool.withdraw(1 ether);
        }
        innerSucceeded = true;
    }

    // --- outer calls, so the attacker is the one holding the position ---

    function deposit(uint256 amount) external {
        vault.deposit(amount, address(this));
    }

    function borrow(uint256 amount) external {
        vault.borrow(amount);
    }

    function repay(uint256 amount) external {
        vault.repay(amount, address(this));
    }

    function redeemAll() external {
        vault.redeem(vault.balanceOf(address(this)), address(this), address(this));
    }

    function supply(uint256 amount) external {
        pool.supply(amount);
    }
}

/// @notice Reentrancy suite. Every one of these is expected to be stopped by a
/// guard; a pass means the guard is doing work, not that the path is absent.
contract AttackReentrancyTest is Test {
    uint256 internal constant YEAR = 365 days;

    HookedToken internal token;
    BorrowLiquidityPool internal pool;
    CollateralVault internal vault;
    Reenterer internal attacker;

    address internal owner = makeAddr("owner");
    address internal lender = makeAddr("lender");

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new HookedToken();

        pool = new BorrowLiquidityPool(
            IERC20(address(token)),
            uint256(2e16) / YEAR,
            uint256(8e16) / YEAR,
            uint256(100e16) / YEAR,
            0.8e18,
            0.1e18,
            owner
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

        attacker = new Reenterer(vault, pool, token);
        token.setHook(address(attacker));
        token.mint(address(attacker), 100_000 ether);

        token.mint(lender, 500_000 ether);
        vm.startPrank(lender);
        token.approve(address(pool), type(uint256).max);
        pool.supply(500_000 ether);
        vm.stopPrank();
    }

    /// @dev R1 — the one the pool's own comment calls load-bearing. `repay`
    /// zeroes the debt *before* pulling tokens, so during that transfer the
    /// position momentarily reads as debt-free. Borrowing inside that window
    /// would be an uncollateralised draw.
    function test_R1_cannotBorrowInsideRepaysTransferWindow() public {
        attacker.deposit(10_000 ether);
        attacker.borrow(5_000 ether);

        // `vault.repay` moves tokens twice: payer -> vault, then vault ->
        // pool. Aim the callback at the second, which lands *after* the pool
        // has already zeroed `scaledDebt` — the window where the position
        // momentarily reads as debt-free. Two guards are held there (the
        // vault's and the pool's); the vault's is the one that fires first,
        // and the pool's is the backstop its own comment describes.
        attacker.set(Reenterer.Action.Borrow);
        token.armAt(2);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.repay(5_000 ether);
        assertEq(vault.lienOf(address(attacker)), 5_000 ether, "state rolled back whole");
    }

    /// @dev R2 — reenter the vault while `super._deposit` has moved the assets
    /// but not yet minted the shares. For that instant `totalAssets` and
    /// `totalSupply` disagree and every share-price view reports high.
    function test_R2_cannotActOnTheVaultInsideAnUnbalancedDeposit() public {
        attacker.set(Reenterer.Action.Settle);
        token.arm(true);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.deposit(1_000 ether);
    }

    /// @dev R3 — the mirror on the way out: shares burned, assets not yet
    /// gone.
    function test_R3_cannotReenterInsideAWithdrawal() public {
        attacker.deposit(1_000 ether);

        attacker.set(Reenterer.Action.Deposit);
        token.arm(true);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.redeemAll();
    }

    /// @dev R4 — double-withdraw the same shares by reentering the redeem.
    function test_R4_cannotDoubleRedeemTheSameShares() public {
        attacker.deposit(1_000 ether);

        attacker.set(Reenterer.Action.Withdraw);
        token.arm(true);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.redeemAll();

        // Nothing partial was left behind.
        assertGt(vault.balanceOf(address(attacker)), 0, "the position survived the failed attack intact");
    }
}
