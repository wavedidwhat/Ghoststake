// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { CollateralVault, ILienSource } from "./CollateralVault.sol";
import { ISettlementSink, ParimutuelRound } from "./ParimutuelRound.sol";

/// @notice Borrow against collateral and take a position with the proceeds, in
/// one transaction — and unwind it the same way when the round settles.
///
/// This contract holds no per-user accounting of its own. It was tempting to
/// track borrowed principal here, but a user can hold positions in several
/// rounds at once and settlement arrives per round, so any such figure is
/// wrong the moment the second position opens. The vault's lien is the single
/// source of truth and it is read live; `PositionOpened` carries the amount
/// for anyone indexing history.
///
/// This is the contract that makes GhostStake one product rather than a lending
/// protocol and a prediction market sharing a repository.
///
/// # The borrowed funds never touch the borrower's wallet
///
/// `CollateralVault.borrowFor` pays the caller, which is this contract, while
/// the debt lands on the borrower. So the proceeds go vault → router → round
/// without ever being spendable by the borrower. That is not a convenience:
/// a path where the funds land in a wallet first is a path where they can be
/// moved somewhere else before the position is opened.
///
/// # Why the borrower has to opt in
///
/// Being whitelisted by the round is not consent to open someone's debt. The
/// borrower grants this contract an allowance through
/// `CollateralVault.approveBorrowDelegate`, and it is bounded and revocable.
/// Without it `borrowFor` reverts, so a bug or a compromise here cannot
/// manufacture debt for accounts that never agreed to any.
///
/// # Settlement never reverts
///
/// Payouts route through `onPositionSettled`, and a sink that reverts strands
/// every payout it funded — for every user, permanently, because the round
/// contract has no fallback path (ADR 0013, finding 5). The three rules below
/// come from GHO-16 and each one closes a way the obvious version fails:
///
///   1. Cap the repayment at the outstanding lien. `CollateralVault.repay`
///      caps internally, so repaying more would leave the excess sitting here.
///   2. Skip repayment entirely at zero. `repay` reverts with `NothingToRepay`
///      on a cleared lien — which is exactly what a liquidator leaves behind.
///   3. Forward whatever the debt could not absorb to the user, or their
///      winnings are stranded in this contract.
contract BorrowToPositionRouter is ISettlementSink, ReentrancyGuard {
    using SafeERC20 for IERC20;

    CollateralVault public immutable vault;
    ParimutuelRound public immutable market;
    IERC20 public immutable asset;

    event PositionOpened(
        uint256 indexed roundId, address indexed user, ParimutuelRound.Side side, uint256 borrowed, uint256 own
    );
    event PositionSettled(address indexed user, uint256 received, uint256 repaid, uint256 returned);

    error ZeroAddress();
    error NothingToStake();
    error AssetMismatch();
    error OnlyMarket(address caller);

    constructor(CollateralVault vault_, ParimutuelRound market_) {
        if (address(vault_) == address(0) || address(market_) == address(0)) revert ZeroAddress();
        // Both legs move the same token. If they did not, the borrowed
        // proceeds could not be staked and every call would fail at transfer
        // time with something far less obvious than this.
        if (vault_.asset() != address(market_.stakeAsset())) revert AssetMismatch();

        vault = vault_;
        market = market_;
        asset = IERC20(vault_.asset());
    }

    /// @notice Borrow `borrowAmount` against your collateral, add `ownAmount`
    /// from your wallet, and stake the total on `side` of `roundId`.
    ///
    /// Either amount may be zero, but not both. Everything happens in one
    /// transaction, so a failure in any leg — insufficient allowance, the LTV
    /// ceiling, a closed entry window — reverts the whole thing and leaves no
    /// debt behind.
    ///
    /// @dev The health factor is checked once, inside `borrowFor`, and that is
    /// sufficient rather than a shortcut: staking moves the borrowed funds into
    /// the round but changes neither the collateral backing the loan nor the
    /// size of the lien, so a second check after the stake would be reading the
    /// same numbers.
    function openPosition(uint256 roundId, ParimutuelRound.Side side, uint256 borrowAmount, uint256 ownAmount)
        external
        nonReentrant
        returns (uint256 staked)
    {
        staked = borrowAmount + ownAmount;
        if (staked == 0) revert NothingToStake();

        if (ownAmount != 0) {
            asset.safeTransferFrom(msg.sender, address(this), ownAmount);
        }
        if (borrowAmount != 0) {
            // Debt lands on msg.sender; the proceeds land here.
            vault.borrowFor(msg.sender, borrowAmount);
        }

        asset.forceApprove(address(market), staked);
        market.takePositionFor(roundId, msg.sender, side, staked);

        emit PositionOpened(roundId, msg.sender, side, borrowAmount, ownAmount);
    }

    /// @inheritdoc ISettlementSink
    ///
    /// @dev Called by the round after it has already transferred the payout
    /// here, so this contract is holding `amount` when it runs.
    ///
    /// Note what is deliberately absent: any branch that can revert. The
    /// repayment is capped and skipped at zero, and the remainder is forwarded
    /// rather than held.
    function onPositionSettled(address user, uint256 amount) external nonReentrant {
        // Only the round may declare a settlement. Without this, anyone could
        // call in and have this contract spend its balance repaying a debt
        // nobody asked it to.
        if (msg.sender != address(market)) revert OnlyMarket(msg.sender);

        // Accrue before reading the balance, not after. `repay` accrues on
        // entry, so a lien read beforehand is already stale by the time the
        // repayment lands — and the difference is left behind as dust debt
        // that never clears, on every settlement, forever.
        ILienSource(address(vault.lienSource())).accrue();

        uint256 owed = vault.lienOf(user);
        uint256 toRepay = amount < owed ? amount : owed;

        if (toRepay != 0) {
            asset.forceApprove(address(vault), toRepay);
            vault.repay(toRepay, user);
        }

        uint256 surplus = amount - toRepay;
        if (surplus != 0) {
            asset.safeTransfer(user, surplus);
        }

        emit PositionSettled(user, amount, toRepay, surplus);
    }
}
