// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CollateralVault, ILienSource } from "../../src/CollateralVault.sol";
import { BorrowLiquidityPool } from "../../src/BorrowLiquidityPool.sol";

/// @notice Shared rig for the adversarial suites. Deliberately mirrors
/// `script/Deploy.s.sol`'s parameters rather than picking friendly ones — an
/// attack that only works against test-only numbers proves nothing about what
/// ships.
abstract contract AttackHarness is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;

    uint256 internal constant MAX_LTV = 5e17; // 50%
    uint256 internal constant LIQ_THRESHOLD = 65e16; // 65%
    uint256 internal constant LIQ_BONUS = 5e16; // 5%
    uint256 internal constant CLOSE_FACTOR = 5e17; // 50%
    uint256 internal constant VAULT_YIELD = uint256(5e16) / YEAR; // 5% APR

    BorrowLiquidityPool internal pool;
    CollateralVault internal vault;
    ERC20Mock internal token;

    address internal owner = makeAddr("owner");
    address internal lender = makeAddr("lender");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");
    address internal victim = makeAddr("victim");

    function _deployStack() internal {
        vm.warp(1_700_000_000);
        token = new ERC20Mock();

        pool = new BorrowLiquidityPool(
            IERC20(address(token)),
            uint256(2e16) / YEAR, // base
            uint256(8e16) / YEAR, // slope1
            uint256(100e16) / YEAR, // slope2
            0.8e18, // kink
            0.1e18, // reserve factor
            owner
        );

        vault = new CollateralVault(
            IERC20(address(token)),
            VAULT_YIELD,
            ILienSource(address(pool)),
            CollateralVault.RiskParams({
                maxLTV: MAX_LTV,
                liquidationThreshold: LIQ_THRESHOLD,
                liquidationBonus: LIQ_BONUS,
                closeFactor: CLOSE_FACTOR
            })
        );

        vm.prank(owner);
        pool.setBorrowModule(address(vault));

        address[5] memory users = [alice, bob, mallory, victim, lender];
        for (uint256 i = 0; i < users.length; i++) {
            _fund(users[i], 1_000_000 ether);
        }

        vm.prank(lender);
        pool.supply(500_000 ether);
    }

    function _fund(address user, uint256 amount) internal {
        token.mint(user, amount);
        vm.startPrank(user);
        token.approve(address(vault), type(uint256).max);
        token.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    function _deposit(address user, uint256 amount) internal {
        vm.prank(user);
        vault.deposit(amount, user);
    }

    function _borrow(address user, uint256 amount) internal {
        vm.prank(user);
        vault.borrow(amount);
    }

    /// @dev Net worth in tokens: wallet, plus what the vault would actually
    /// pay for the shares, minus what is owed. The only figure an attack has
    /// to move to be an attack.
    function _netWorth(address user) internal view returns (int256) {
        return int256(token.balanceOf(user) + vault.convertToAssets(vault.balanceOf(user))) - int256(vault.lienOf(user));
    }
}
