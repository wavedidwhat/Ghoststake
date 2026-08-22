// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Shared lending liquidity for GhostStake. Suppliers deposit here,
/// borrowers draw against the pooled un-borrowed balance, and borrowers'
/// interest is what pays suppliers. Aave/Compound shaped.
///
/// # Why an index instead of a per-user rate
///
/// The borrow rate is a function of utilization, so it changes every time
/// anyone borrows or repays. That makes a per-user "rate snapshot at last
/// interaction" wrong: a user who last touched their position before a rate
/// change would have their whole elapsed window priced at a stale rate.
/// Fixing that by re-settling every user on every rate change means looping
/// over all users on every borrow, which does not fit in a block.
///
/// So balances are stored **scaled**: what's in storage is the balance
/// divided by the index at the time it was written. The live balance is
/// `scaled * currentIndex`. A rate change advances one number and every
/// position stays correct without being touched — O(1) forever, and exact
/// regardless of how often anyone interacts.
///
/// # Two indices
///
/// `borrowIndex` grows at the borrow rate, `supplyIndex` at the supply rate.
/// The gap between them is the reserve factor — the protocol's cut — which
/// is why they can't be one number.
///
///   utilization  U = borrowed / (available + borrowed)
///   borrowRate     = kinked curve of U (see `borrowRatePerSecond`)
///   supplyRate     = borrowRate * U * (1 - reserveFactor)
///
/// Supply rate carries the `* U` because only the borrowed fraction is
/// earning anything — idle liquidity pays nobody.
///
/// # Accrual is mildly path-dependent, and that is deliberate
///
/// Each accrual advances the index multiplicatively by `rate * elapsed`, so
/// accruing twice over two periods yields marginally more than once over
/// the whole span — the same shape as the `settle()` grind fixed in
/// CollateralVault (GHO-7). It is not fixed the same way here, for a reason
/// worth writing down.
///
/// In the vault, `settle(alice)` moved value to **alice alone**, so anyone
/// could grind it for private gain. `accrue()` moves the index for **every
/// supplier at once**. A supplier holding 1% of the pool pays 100% of the
/// gas to capture 1% of an effect bounded by `e^(rT) - (1+rT)` — about
/// 0.08%/year at a 4% rate. The economics are self-defeating, and every
/// mutating entry point already calls `accrue()` anyway, so the index is
/// advanced constantly by normal traffic rather than left for someone to
/// farm.
///
/// Removing it entirely would mean integrating a varying rate over time
/// without a cumulative product, which is what the index *is*. Aave and
/// Compound both live with the same residue. `test_accrueCadenceEffectIsNegligible`
/// pins the magnitude so a future change can't quietly widen it.
contract BorrowLiquidityPool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Index precision. Higher than WAD because indices compound and
    /// precision loss here is permanent — it can never be recovered on a
    /// later accrual.
    uint256 public constant RAY = 1e27;

    /// @dev Rate and ratio precision. 1e18 = 100%.
    uint256 public constant WAD = 1e18;

    IERC20 public immutable asset;

    // --- interest rate curve, all per-second WAD rates ---

    /// @dev Rate at zero utilization.
    uint256 public immutable baseRatePerSecond;
    /// @dev Additional rate accrued linearly from 0 up to `kink`.
    uint256 public immutable slope1PerSecond;
    /// @dev Additional rate accrued linearly from `kink` up to 100%. Steep
    /// on purpose — past the kink, liquidity is scarce and the rate has to
    /// both deter new borrowing and pull supply in.
    uint256 public immutable slope2PerSecond;
    /// @dev Target utilization where the curve bends. WAD.
    uint256 public immutable kink;
    /// @dev Protocol's share of borrow interest. WAD.
    uint256 public immutable reserveFactor;

    // --- state ---

    uint256 public supplyIndex = RAY;
    uint256 public borrowIndex = RAY;
    uint256 public lastAccrualTime;

    uint256 public totalSupplyScaled;
    uint256 public totalBorrowScaled;
    /// @dev Protocol-owned. Held in the contract but never lendable and
    /// never withdrawable by suppliers.
    uint256 public totalReserves;

    mapping(address => uint256) public scaledSupply;
    mapping(address => uint256) public scaledDebt;

    /// @dev The only address allowed to move debt. GHO-8's borrow logic.
    /// Debt has to be gated because this contract has no concept of
    /// collateral — it trusts the borrow module to have checked a health
    /// factor before drawing.
    address public borrowModule;

    event Supplied(address indexed user, uint256 amount, uint256 scaledAmount);
    event Withdrawn(address indexed user, uint256 amount, uint256 scaledAmount);
    event Borrowed(address indexed user, uint256 amount, uint256 scaledAmount);
    event Repaid(address indexed payer, address indexed user, uint256 amount, uint256 scaledAmount);
    event Accrued(uint256 supplyIndex, uint256 borrowIndex, uint256 reservesAdded);
    event BorrowModuleSet(address indexed module);
    event ReservesWithdrawn(address indexed to, uint256 amount);

    error ZeroAmount();
    error NotBorrowModule(address caller);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error InsufficientSupplyBalance(uint256 requested, uint256 balance);
    error RepayExceedsDebt(uint256 requested, uint256 debt);
    error InvalidCurve();

    modifier onlyBorrowModule() {
        if (msg.sender != borrowModule) revert NotBorrowModule(msg.sender);
        _;
    }

    constructor(
        IERC20 asset_,
        uint256 baseRatePerSecond_,
        uint256 slope1PerSecond_,
        uint256 slope2PerSecond_,
        uint256 kink_,
        uint256 reserveFactor_,
        address initialOwner
    ) Ownable(initialOwner) {
        if (kink_ == 0 || kink_ >= WAD || reserveFactor_ >= WAD) revert InvalidCurve();

        asset = asset_;
        baseRatePerSecond = baseRatePerSecond_;
        slope1PerSecond = slope1PerSecond_;
        slope2PerSecond = slope2PerSecond_;
        kink = kink_;
        reserveFactor = reserveFactor_;
        lastAccrualTime = block.timestamp;
    }

    function setBorrowModule(address module) external onlyOwner {
        borrowModule = module;
        emit BorrowModuleSet(module);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @dev Liquidity actually lendable right now. Reserves sit in the
    /// contract but belong to the protocol, so they are excluded.
    function availableLiquidity() public view returns (uint256) {
        uint256 balance = asset.balanceOf(address(this));
        return balance > totalReserves ? balance - totalReserves : 0;
    }

    function totalSupplied() public view returns (uint256) {
        return Math.mulDiv(totalSupplyScaled, supplyIndex, RAY);
    }

    function totalBorrowed() public view returns (uint256) {
        return Math.mulDiv(totalBorrowScaled, borrowIndex, RAY);
    }

    function balanceOfSupply(address user) public view returns (uint256) {
        return Math.mulDiv(scaledSupply[user], supplyIndex, RAY);
    }

    function balanceOfDebt(address user) public view returns (uint256) {
        return Math.mulDiv(scaledDebt[user], borrowIndex, RAY);
    }

    /// @notice Fraction of the pool currently lent out. WAD.
    function utilization() public view returns (uint256) {
        uint256 borrowed = totalBorrowed();
        if (borrowed == 0) return 0;
        return Math.mulDiv(borrowed, WAD, availableLiquidity() + borrowed);
    }

    /// @notice The kinked curve. Shallow below `kink`, steep above.
    function borrowRatePerSecond() public view returns (uint256) {
        return _borrowRateAt(utilization());
    }

    function _borrowRateAt(uint256 u) internal view returns (uint256) {
        if (u <= kink) {
            return baseRatePerSecond + Math.mulDiv(slope1PerSecond, u, kink);
        }
        uint256 excess = u - kink;
        return baseRatePerSecond + slope1PerSecond + Math.mulDiv(slope2PerSecond, excess, WAD - kink);
    }

    /// @notice What suppliers earn. Borrow interest, scaled by how much of
    /// the pool is actually lent out, less the protocol's cut.
    function supplyRatePerSecond() public view returns (uint256) {
        return _supplyRateAt(utilization());
    }

    function _supplyRateAt(uint256 u) internal view returns (uint256) {
        uint256 borrowRate = _borrowRateAt(u);
        uint256 gross = Math.mulDiv(borrowRate, u, WAD);
        return Math.mulDiv(gross, WAD - reserveFactor, WAD);
    }

    // ------------------------------------------------------------------
    // Accrual
    // ------------------------------------------------------------------

    /// @notice Advances both indices to now. Permissionless and free to
    /// call; every state-changing entry point calls it first so no action
    /// is ever priced at a stale index.
    function accrue() public {
        uint256 elapsed = block.timestamp - lastAccrualTime;
        if (elapsed == 0) return;

        uint256 u = utilization();
        uint256 borrowGrowth = _borrowRateAt(u) * elapsed;
        uint256 supplyGrowth = _supplyRateAt(u) * elapsed;

        uint256 reservesAdded;
        if (borrowGrowth != 0) {
            // Reserve cut is taken from the interest borrowers actually owe
            // this period, so the books stay balanced against the index move.
            uint256 borrowInterest = Math.mulDiv(totalBorrowed(), borrowGrowth, WAD);
            reservesAdded = Math.mulDiv(borrowInterest, reserveFactor, WAD);
            totalReserves += reservesAdded;

            borrowIndex += Math.mulDiv(borrowIndex, borrowGrowth, WAD);
        }
        if (supplyGrowth != 0) {
            supplyIndex += Math.mulDiv(supplyIndex, supplyGrowth, WAD);
        }

        lastAccrualTime = block.timestamp;
        emit Accrued(supplyIndex, borrowIndex, reservesAdded);
    }

    // ------------------------------------------------------------------
    // Supply side
    // ------------------------------------------------------------------

    function supply(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        accrue();

        // Round scaled amount DOWN so a supplier can never scale up into
        // more than they paid for.
        uint256 scaled = Math.mulDiv(amount, RAY, supplyIndex);
        scaledSupply[msg.sender] += scaled;
        totalSupplyScaled += scaled;

        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Supplied(msg.sender, amount, scaled);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        accrue();

        uint256 balance = balanceOfSupply(msg.sender);
        if (amount > balance) revert InsufficientSupplyBalance(amount, balance);

        // The liquidity lock this protocol is structurally exposed to: your
        // funds may be out as someone else's loan. Named error so the UI can
        // say that plainly rather than surfacing a bare revert.
        uint256 available = availableLiquidity();
        if (amount > available) revert InsufficientLiquidity(amount, available);

        // Round the scaled burn UP so withdrawing can never leave a
        // free residue behind, and clear the position outright on a full
        // exit so rounding dust cannot survive.
        uint256 scaled = Math.mulDiv(amount, RAY, supplyIndex, Math.Rounding.Ceil);
        uint256 held = scaledSupply[msg.sender];
        if (scaled >= held) {
            scaled = held;
            scaledSupply[msg.sender] = 0;
        } else {
            scaledSupply[msg.sender] = held - scaled;
        }
        totalSupplyScaled -= scaled;

        asset.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, scaled);
    }

    // ------------------------------------------------------------------
    // Borrow side
    // ------------------------------------------------------------------

    /// @dev Gated: this contract does not know about collateral, so it
    /// trusts the borrow module to have checked a health factor first.
    function borrow(uint256 amount, address onBehalfOf) external nonReentrant onlyBorrowModule {
        if (amount == 0) revert ZeroAmount();
        accrue();

        uint256 available = availableLiquidity();
        if (amount > available) revert InsufficientLiquidity(amount, available);

        // Round debt UP so a borrower can never round their obligation down.
        uint256 scaled = Math.mulDiv(amount, RAY, borrowIndex, Math.Rounding.Ceil);
        scaledDebt[onBehalfOf] += scaled;
        totalBorrowScaled += scaled;

        asset.safeTransfer(msg.sender, amount);
        emit Borrowed(onBehalfOf, amount, scaled);
    }

    /// @notice Repay someone's debt. Deliberately open to any caller — a
    /// third party repaying on your behalf can only ever help you, and
    /// liquidation (GHO-9) needs exactly this.
    function repay(uint256 amount, address onBehalfOf) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        accrue();

        uint256 debt = balanceOfDebt(onBehalfOf);
        if (amount > debt) revert RepayExceedsDebt(amount, debt);

        // Round the scaled reduction DOWN so repaying can never clear more
        // debt than was paid for; full repayment is handled exactly.
        uint256 scaled = Math.mulDiv(amount, RAY, borrowIndex);
        uint256 owed = scaledDebt[onBehalfOf];
        if (amount == debt || scaled >= owed) {
            scaled = owed;
            scaledDebt[onBehalfOf] = 0;
        } else {
            scaledDebt[onBehalfOf] = owed - scaled;
        }
        totalBorrowScaled -= scaled;

        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Repaid(msg.sender, onBehalfOf, amount, scaled);
    }

    // ------------------------------------------------------------------
    // Reserves
    // ------------------------------------------------------------------

    function withdrawReserves(address to, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > totalReserves) revert InsufficientSupplyBalance(amount, totalReserves);

        totalReserves -= amount;
        asset.safeTransfer(to, amount);
        emit ReservesWithdrawn(to, amount);
    }
}
