// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { EntryPausable } from "./EntryPausable.sol";
import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";

/// @notice The creditor a loan is owed to. Narrow on purpose: the vault needs
/// the pool's accounting and nothing else.
interface IStockLoanPool {
    function asset() external view returns (IERC20);
    function treasury() external view returns (address);
    function balanceOfDebt(address user) external view returns (uint256);
    function borrow(uint256 amount, address onBehalfOf) external;
    function repay(uint256 amount, address onBehalfOf) external;
    function accrue() external;
    function absorbBadDebt(address user) external returns (uint256 loss);
}

/// @notice The one piece of a Robinhood `Stock` token this vault has to read.
/// See `CollateralConfig.scaledUI`.
interface IScaledUI {
    function uiMultiplier() external view returns (uint256);
}

/// @notice Borrow a stablecoin against tokenized stock.
///
/// This is not `CollateralVault` with a price bolted on. That contract's whole
/// design rests on collateral and debt being one asset: yield accrues in it,
/// liquidators repay in it, bad debt is `debt > collateral`. Stock collateral
/// breaks every one of those, so this is a separate contract with a separate
/// pool. It has a second benefit: a stock crash cannot reach the lenders of
/// the staking pool, because `BorrowLiquidityPool.setBorrowModule` is one-shot
/// and each pool has exactly one module.
///
/// # What is different about stock tokens
///
/// Read off the deployed `Stock` implementation on Robinhood testnet, not
/// assumed:
///
/// - **`uiMultiplier`.** A split does not change anyone's raw balance; it
///   changes a multiplier, and the feed's price is per *share*. Value is
///   `raw * multiplier * price`. Leave the multiplier out and a 2-for-1 split
///   silently halves the price while leaving the balance, mispricing every
///   position by half. Configured per collateral (`scaledUI`) rather than
///   probed with a try/catch, because a probe that falls back to 1x on a
///   revert is a silent wrong answer.
/// - **Pause and a blocklist.** Token-level and global pause revert every
///   transfer and approve; a blocked address cannot send or receive. If the
///   vault is blocked or the token paused, collateral cannot be returned or
///   seized. Nothing here can route around that, and it is a risk the lender
///   is taking.
/// - **`adminBurn`.** The issuer can burn from any address, including this
///   vault. Value is computed from what each user has *recorded*, so a burn
///   leaves the ledger claiming collateral that is gone. Not defensible
///   on-chain; it is why LTVs are conservative and why this is a testnet
///   product.
///
/// # Prices: when a stale one is fine
///
/// Stock feeds go quiet when the market is closed, over a weekend for about
/// sixty-five hours. A stale price is then the *correct* price, and rejecting
/// it would freeze liquidation for exactly the period nobody can react. But a
/// dead feed looks identical. So two bounds per collateral:
///
/// - `maxAge` for anything that adds risk (borrow, withdraw while indebted).
/// - `liquidationMaxAge`, longer, for liquidation and write-off. A weekend is
///   inside it; a week of silence is not.
///
/// Repaying and depositing need no price and never read one. Withdrawing with
/// no debt reads none either — nobody is ever locked in by a broken feed.
///
/// # Where the platform earns
///
/// - the pool's reserve factor on borrower interest (pool-side),
/// - `originationFee`, added to the borrower's debt at borrow and paid to the
///   treasury in cash at once,
/// - `liquidationProtocolShare` of the liquidation bonus, paid by the
///   liquidator in stablecoin to the treasury.
///
/// Reserves are also what pays first if a loan goes bad.
///
/// Immutable after deploy: no owner, no setters, no proxy (GHO-52). The
/// guardian can only stop new entries (`EntryPausable`).
contract StockLoanVault is ReentrancyGuard, EntryPausable {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;
    uint256 public constant MAX_COLLATERALS = 8;
    /// @dev Ceilings, so a fat-fingered deploy cannot make the fee a confiscation.
    uint256 public constant MAX_ORIGINATION_FEE = 0.02e18;

    struct CollateralConfig {
        IERC20 token;
        AggregatorV3Interface feed;
        /// @dev Most you may borrow against this collateral, as a fraction of value.
        uint256 maxLTV;
        /// @dev Debt/value at which it counts towards liquidation.
        uint256 liquidationThreshold;
        /// @dev Discount the liquidator receives on seized collateral.
        uint256 liquidationBonus;
        /// @dev Oldest price that may back new risk, in seconds.
        uint256 maxAge;
        /// @dev Oldest price that may back a liquidation, in seconds.
        uint256 liquidationMaxAge;
        /// @dev Whether the token exposes `uiMultiplier()` (Robinhood `Stock`).
        bool scaledUI;
    }

    struct Collateral {
        IERC20 token;
        AggregatorV3Interface feed;
        uint256 maxLTV;
        uint256 liquidationThreshold;
        uint256 liquidationBonus;
        uint256 maxAge;
        uint256 liquidationMaxAge;
        bool scaledUI;
        uint8 tokenDecimals;
        uint8 feedDecimals;
    }

    IStockLoanPool public immutable pool;
    IERC20 public immutable stable;
    uint8 public immutable stableDecimals;
    uint256 public immutable originationFee;
    uint256 public immutable liquidationProtocolShare;
    /// @dev Fraction of a loan one liquidation may clear while the position is
    /// only just underwater. Lifted to 100% deeper down, per collateral.
    uint256 public immutable closeFactor;

    Collateral[] internal _collaterals;
    mapping(address token => uint256 indexPlusOne) internal _indexOf;

    mapping(address user => mapping(address token => uint256)) public collateralOf;

    event CollateralDeposited(address indexed user, address indexed token, uint256 amount);
    event CollateralWithdrawn(address indexed user, address indexed token, uint256 amount);
    event Borrowed(address indexed user, uint256 received, uint256 fee, uint256 debtAfter);
    event Repaid(address indexed payer, address indexed user, uint256 amount, uint256 debtAfter);
    event Liquidated(
        address indexed liquidator,
        address indexed user,
        address indexed token,
        uint256 repaid,
        uint256 seized,
        uint256 protocolFee,
        uint256 debtAfter
    );
    event BadDebtWrittenOff(address indexed user, uint256 loss, uint256 collateralsSeized);

    error ZeroAmount();
    error ZeroAddress();
    error InvalidConfig();
    error UnknownCollateral(address token);
    error InsufficientCollateral(uint256 requested, uint256 available);
    error ExceedsBorrowLimit(uint256 debtAfter, uint256 limit);
    error StalePrice(address token, uint256 age, uint256 maxAge);
    error InvalidPrice(address token);
    error PositionNotLiquidatable(address user, uint256 healthFactor);
    error ExceedsCloseFactor(uint256 requested, uint256 max);
    error WithdrawWouldExceedLimit(uint256 debt, uint256 limitAfter);
    error NotWritableOff(address user);
    error NothingToRepay(address user);
    error NothingToSeize(address user, address token);
    error UnexpectedTransferAmount(uint256 expected, uint256 received);

    constructor(
        IStockLoanPool pool_,
        CollateralConfig[] memory configs,
        uint256 originationFee_,
        uint256 liquidationProtocolShare_,
        uint256 closeFactor_,
        address pauseGuardian_
    ) EntryPausable(pauseGuardian_) {
        if (address(pool_) == address(0)) revert ZeroAddress();
        if (configs.length == 0 || configs.length > MAX_COLLATERALS) revert InvalidConfig();
        if (originationFee_ > MAX_ORIGINATION_FEE) revert InvalidConfig();
        if (liquidationProtocolShare_ > WAD) revert InvalidConfig();
        if (closeFactor_ == 0 || closeFactor_ > WAD) revert InvalidConfig();

        pool = pool_;
        stable = pool_.asset();
        stableDecimals = IERC20Metadata(address(stable)).decimals();
        originationFee = originationFee_;
        liquidationProtocolShare = liquidationProtocolShare_;
        closeFactor = closeFactor_;

        for (uint256 i; i < configs.length; ++i) {
            CollateralConfig memory c = configs[i];
            if (address(c.token) == address(0) || address(c.feed) == address(0)) revert ZeroAddress();
            if (_indexOf[address(c.token)] != 0) revert InvalidConfig();
            // Same ordering rules as CollateralVault, plus one: the threshold
            // must leave room for the bonus, or a position at the line owes
            // more than it holds once the bonus is paid.
            if (c.maxLTV == 0 || c.maxLTV >= c.liquidationThreshold) revert InvalidConfig();
            if (c.liquidationBonus >= WAD) revert InvalidConfig();
            if (c.liquidationThreshold * (WAD + c.liquidationBonus) >= WAD * WAD) revert InvalidConfig();
            if (c.maxAge == 0 || c.liquidationMaxAge < c.maxAge) revert InvalidConfig();

            _collaterals.push(
                Collateral({
                    token: c.token,
                    feed: c.feed,
                    maxLTV: c.maxLTV,
                    liquidationThreshold: c.liquidationThreshold,
                    liquidationBonus: c.liquidationBonus,
                    maxAge: c.maxAge,
                    liquidationMaxAge: c.liquidationMaxAge,
                    scaledUI: c.scaledUI,
                    tokenDecimals: IERC20Metadata(address(c.token)).decimals(),
                    feedDecimals: c.feed.decimals()
                })
            );
            _indexOf[address(c.token)] = i + 1;
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function collateralCount() external view returns (uint256) {
        return _collaterals.length;
    }

    function collateralAt(uint256 i) external view returns (Collateral memory) {
        return _collaterals[i];
    }

    function debtOf(address user) public view returns (uint256) {
        return pool.balanceOfDebt(user);
    }

    /// @notice What `amount` of `token` is worth in stablecoin units at the
    /// current price, rejecting a price older than `maxAge`.
    function valueOf(address token, uint256 amount, uint256 maxAge) public view returns (uint256) {
        return _value(_get(token), amount, maxAge);
    }

    /// @notice The user's position, priced for liquidation purposes (the
    /// looser age bound). Reverts if a held token's price is unusable.
    /// @return debt Loan including accrued interest.
    /// @return value Total collateral value.
    /// @return borrowLimit Most debt the position may carry (maxLTV-weighted).
    /// @return liquidationLine Debt at which it becomes liquidatable.
    function positionOf(address user)
        public
        view
        returns (uint256 debt, uint256 value, uint256 borrowLimit, uint256 liquidationLine)
    {
        debt = debtOf(user);
        (value, borrowLimit, liquidationLine) = _totals(user, true);
    }

    /// @notice Health factor, WAD. Below 1e18 is liquidatable. `type(uint256).max` with no debt.
    function healthFactor(address user) public view returns (uint256) {
        uint256 debt = debtOf(user);
        if (debt == 0) return type(uint256).max;
        (,, uint256 line) = _totals(user, true);
        return Math.mulDiv(line, WAD, debt);
    }

    function isLiquidatable(address user) public view returns (bool) {
        return healthFactor(user) < WAD;
    }

    // ------------------------------------------------------------------
    // Collateral in and out
    // ------------------------------------------------------------------

    function deposit(address token, uint256 amount) external nonReentrant whenEntriesOpen {
        if (amount == 0) revert ZeroAmount();
        _get(token);
        collateralOf[msg.sender][token] += amount;
        // Measured, not trusted: a token that takes a fee on transfer would
        // otherwise credit more than arrived. Stock tokens do not; this keeps
        // the ledger true if a listing ever does.
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert UnexpectedTransferAmount(amount, received);
        emit CollateralDeposited(msg.sender, token, amount);
    }

    /// @notice Take collateral back. With no debt it reads no price at all;
    /// with debt the position must stay within its borrow limit afterwards.
    /// Never pausable.
    function withdraw(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _get(token);
        uint256 held = collateralOf[msg.sender][token];
        if (amount > held) revert InsufficientCollateral(amount, held);
        collateralOf[msg.sender][token] = held - amount;

        pool.accrue();
        uint256 debt = debtOf(msg.sender);
        if (debt != 0) {
            (, uint256 limit,) = _totals(msg.sender, false);
            if (debt > limit) revert WithdrawWouldExceedLimit(debt, limit);
        }

        IERC20(token).safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, token, amount);
    }

    // ------------------------------------------------------------------
    // Borrow and repay
    // ------------------------------------------------------------------

    /// @notice Borrow `amount` of the stablecoin. The origination fee is added
    /// to the debt, not deducted from what you receive, so `amount` is exactly
    /// what lands in your wallet.
    function borrow(uint256 amount) external nonReentrant whenEntriesOpen {
        if (amount == 0) revert ZeroAmount();
        pool.accrue();

        uint256 fee = Math.mulDiv(amount, originationFee, WAD, Math.Rounding.Ceil);
        uint256 debtAfter = debtOf(msg.sender) + amount + fee;
        (, uint256 limit,) = _totals(msg.sender, false);
        if (debtAfter > limit) revert ExceedsBorrowLimit(debtAfter, limit);

        pool.borrow(amount + fee, msg.sender);
        stable.safeTransfer(msg.sender, amount);
        if (fee != 0) stable.safeTransfer(pool.treasury(), fee);

        emit Borrowed(msg.sender, amount, fee, debtAfter);
    }

    /// @notice Repay part or all of `onBehalfOf`'s loan. Open to anyone, needs
    /// no price, never pausable.
    function repay(uint256 amount, address onBehalfOf) external nonReentrant {
        pool.accrue();
        uint256 debt = debtOf(onBehalfOf);
        if (debt == 0) revert NothingToRepay(onBehalfOf);
        if (amount > debt) amount = debt;
        if (amount == 0) revert ZeroAmount();

        stable.safeTransferFrom(msg.sender, address(this), amount);
        stable.forceApprove(address(pool), amount);
        pool.repay(amount, onBehalfOf);

        emit Repaid(msg.sender, onBehalfOf, amount, debt - amount);
    }

    // ------------------------------------------------------------------
    // Liquidation
    // ------------------------------------------------------------------

    /// @notice Repay part of an underwater loan and take `token` collateral at
    /// a discount. Open to anyone; never pausable.
    /// @param repayAmount Stablecoin to repay; `type(uint256).max` for the most allowed.
    function liquidate(address user, address token, uint256 repayAmount) external nonReentrant {
        Collateral storage c = _get(token);
        pool.accrue();

        uint256 maxRepay = _maxRepay(c, user);
        if (repayAmount == type(uint256).max) repayAmount = maxRepay;
        if (repayAmount == 0) revert ZeroAmount();
        if (repayAmount > maxRepay) revert ExceedsCloseFactor(repayAmount, maxRepay);

        uint256 held = collateralOf[user][token];
        // A liquidator who names a token the borrower does not hold would
        // repay debt and receive nothing. Their mistake, but a revert is
        // cheaper than a lesson.
        if (held == 0) revert NothingToSeize(user, token);
        uint256 seized = Math.min(_tokensFor(c, repayAmount + Math.mulDiv(repayAmount, c.liquidationBonus, WAD)), held);

        // The platform's cut comes out of the bonus and is paid by the
        // liquidator in stablecoin, so the treasury never receives stock.
        uint256 protocolFee = Math.mulDiv(repayAmount, c.liquidationBonus * liquidationProtocolShare, WAD * WAD);

        // Liquidator pays first, then is paid.
        stable.safeTransferFrom(msg.sender, address(this), repayAmount + protocolFee);
        stable.forceApprove(address(pool), repayAmount);
        pool.repay(repayAmount, user);
        if (protocolFee != 0) stable.safeTransfer(pool.treasury(), protocolFee);

        collateralOf[user][token] = held - seized;
        IERC20(token).safeTransfer(msg.sender, seized);

        emit Liquidated(msg.sender, user, token, repayAmount, seized, protocolFee, debtOf(user));
    }

    /// @dev Most of the loan one liquidation may clear; reverts when healthy.
    /// Below `threshold x (1 + bonus)` a capped liquidation leaves the
    /// position worse off than it found it (CollateralVault has the long
    /// argument), so the cap lifts. Per collateral, since the bonus is.
    function _maxRepay(Collateral storage c, address user) internal view returns (uint256) {
        uint256 debt = debtOf(user);
        (,, uint256 line) = _totals(user, true);
        uint256 hf = debt == 0 ? type(uint256).max : Math.mulDiv(line, WAD, debt);
        if (hf >= WAD) revert PositionNotLiquidatable(user, hf);
        uint256 factor = hf < Math.mulDiv(c.liquidationThreshold, WAD + c.liquidationBonus, WAD) ? WAD : closeFactor;
        return Math.mulDiv(debt, factor, WAD);
    }

    /// @notice Close a loan that collateral can no longer cover: hand every
    /// remaining collateral token to the treasury and write the rest off to
    /// the pool (reserves first, then suppliers).
    ///
    /// Permissionless, on evidence: the condition is `debt > collateral value`
    /// at liquidation-grade prices, both read here. Below that line a
    /// liquidation still comes out ahead; above it none can, because the bonus
    /// is paid out of collateral that does not exist. The collateral goes to
    /// the treasury rather than the caller so that a write-off is not a prize.
    /// Recovering its value for suppliers is manual in this version.
    function writeOffBadDebt(address user) external nonReentrant {
        pool.accrue();
        uint256 debt = debtOf(user);
        (uint256 value,,) = _totals(user, true);
        if (debt == 0 || value >= debt) revert NotWritableOff(user);

        address treasury = pool.treasury();
        uint256 seizedCount;
        for (uint256 i; i < _collaterals.length; ++i) {
            IERC20 token = _collaterals[i].token;
            uint256 held = collateralOf[user][address(token)];
            if (held == 0) continue;
            collateralOf[user][address(token)] = 0;
            token.safeTransfer(treasury, held);
            ++seizedCount;
        }

        uint256 loss = pool.absorbBadDebt(user);
        emit BadDebtWrittenOff(user, loss, seizedCount);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _get(address token) internal view returns (Collateral storage) {
        uint256 i = _indexOf[token];
        if (i == 0) revert UnknownCollateral(token);
        return _collaterals[i - 1];
    }

    function _multiplier(Collateral storage c) internal view returns (uint256) {
        return c.scaledUI ? IScaledUI(address(c.token)).uiMultiplier() : WAD;
    }

    /// @dev (price, decimals-scaled) with the staleness and sanity checks.
    function _price(Collateral storage c, uint256 maxAge) internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = c.feed.latestRoundData();
        // A timestamp in the future is a broken feed, not a fresh one.
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) revert InvalidPrice(address(c.token));
        uint256 age = block.timestamp - updatedAt;
        if (age > maxAge) revert StalePrice(address(c.token), age, maxAge);
        return uint256(answer);
    }

    function _value(Collateral storage c, uint256 amount, uint256 maxAge) internal view returns (uint256) {
        if (amount == 0) return 0;
        uint256 price = _price(c, maxAge);
        uint256 shares = Math.mulDiv(amount, _multiplier(c), WAD);
        return Math.mulDiv(shares, price * 10 ** stableDecimals, 10 ** (uint256(c.tokenDecimals) + c.feedDecimals));
    }

    /// @dev Stablecoin value -> token units, at the liquidation-grade price.
    /// The inverse of `_value`.
    function _tokensFor(Collateral storage c, uint256 stableAmount) internal view returns (uint256) {
        uint256 price = _price(c, c.liquidationMaxAge);
        uint256 shares =
            Math.mulDiv(stableAmount, 10 ** (uint256(c.tokenDecimals) + c.feedDecimals), price * 10 ** stableDecimals);
        return Math.mulDiv(shares, WAD, _multiplier(c));
    }

    /// @dev Sums over the configured collateral, skipping tokens the user does
    /// not hold so that a dead feed for a token nobody uses blocks nobody.
    function _totals(address user, bool forLiquidation)
        internal
        view
        returns (uint256 value, uint256 borrowLimit, uint256 liquidationLine)
    {
        for (uint256 i; i < _collaterals.length; ++i) {
            Collateral storage c = _collaterals[i];
            uint256 amount = collateralOf[user][address(c.token)];
            if (amount == 0) continue;
            uint256 v = _value(c, amount, forLiquidation ? c.liquidationMaxAge : c.maxAge);
            value += v;
            borrowLimit += Math.mulDiv(v, c.maxLTV, WAD);
            liquidationLine += Math.mulDiv(v, c.liquidationThreshold, WAD);
        }
    }
}
