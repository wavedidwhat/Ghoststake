// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { BorrowLiquidityPool } from "../../src/BorrowLiquidityPool.sol";
import { BorrowToPositionRouter } from "../../src/BorrowToPositionRouter.sol";
import { CollateralVault } from "../../src/CollateralVault.sol";
import { ParimutuelRound, ISettlementSink } from "../../src/ParimutuelRound.sol";
import { MockRoundOracle } from "../mocks/MockRoundOracle.sol";
import { MockUSDC } from "../../script/mocks/MockUSDC.sol";

/// @notice Drives the whole protocol through random sequences of real user,
/// keeper and owner actions.
///
/// Every action checks its own preconditions and returns early when they do
/// not hold, and the suite runs with `fail_on_revert = true`. That pairing is
/// the point: a call that passes the filter and still reverts means either the
/// filter models the contract wrongly or the contract blocks something it
/// should not — and both are findings. A handler that lets calls revert
/// silently can pass a whole campaign while exercising nothing.
contract ProtocolHandler is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant USDC = 1e6;

    BorrowLiquidityPool public immutable pool;
    CollateralVault public immutable vault;
    ParimutuelRound public immutable market;
    BorrowToPositionRouter public immutable router;
    MockRoundOracle public immutable oracle;
    MockUSDC public immutable token;
    address public immutable owner;

    address[] public users;
    address[] public lenders;
    address public liquidator = makeAddr("liquidator");

    // --- ghosts: the market's cash flows, tracked independently of its books ---

    uint256 public ghost_staked;
    uint256 public ghost_paidOut;
    uint256 public ghost_feesWithdrawn;
    mapping(uint256 roundId => uint256) public ghost_paidOutOf;

    // --- ghosts: index monotonicity, checked after every call ---

    uint256 public lastBorrowIndex;
    uint256 public lastSupplyIndex;
    bool public ghost_borrowIndexFell;
    bool public ghost_supplyIndexFellOutsideWriteOff;

    /// @dev Every time any borrower's scaled debt went down: repayment, exit,
    /// router settlement, liquidation, write-off. Each can forgive under one
    /// wei — see `invariant_poolIsSolventWithinRounding` — so the pool's books
    /// are allowed to run short by at most this many wei in total.
    uint256 public ghost_debtReductions;

    // --- coverage: what actually ran, so a passing campaign can be read ---

    mapping(bytes32 action => uint256) public calls;

    constructor(
        BorrowLiquidityPool pool_,
        CollateralVault vault_,
        ParimutuelRound market_,
        BorrowToPositionRouter router_,
        MockRoundOracle oracle_,
        MockUSDC token_,
        address owner_,
        address[] memory users_,
        address[] memory lenders_
    ) {
        pool = pool_;
        vault = vault_;
        market = market_;
        router = router_;
        oracle = oracle_;
        token = token_;
        owner = owner_;
        users = users_;
        lenders = lenders_;
        lastBorrowIndex = pool.borrowIndex();
        lastSupplyIndex = pool.supplyIndex();
    }

    /// @dev `writeOff` is the one action allowed to move the supply index
    /// down, so it passes true.
    modifier checkIndices(bool supplyMayFall) {
        uint256[] memory scaledBefore = new uint256[](users.length);
        for (uint256 i = 0; i < users.length; i++) {
            scaledBefore[i] = pool.scaledDebt(users[i]);
        }
        _;
        for (uint256 i = 0; i < users.length; i++) {
            if (pool.scaledDebt(users[i]) < scaledBefore[i]) ghost_debtReductions++;
        }
        uint256 b = pool.borrowIndex();
        uint256 s = pool.supplyIndex();
        if (b < lastBorrowIndex) ghost_borrowIndexFell = true;
        if (s < lastSupplyIndex && !supplyMayFall) ghost_supplyIndexFellOutsideWriteOff = true;
        lastBorrowIndex = b;
        lastSupplyIndex = s;
    }

    function usersLength() external view returns (uint256) {
        return users.length;
    }

    function lendersLength() external view returns (uint256) {
        return lenders.length;
    }

    function _user(uint256 seed) internal view returns (address) {
        return users[seed % users.length];
    }

    function _lender(uint256 seed) internal view returns (address) {
        return lenders[seed % lenders.length];
    }

    function _round(uint256 seed) internal view returns (uint256 roundId, ParimutuelRound.Round memory round) {
        uint256 count = market.roundCount();
        if (count == 0) return (0, round);
        roundId = (seed % count) + 1;
        round = market.rounds(roundId);
    }

    function _mint(address to, uint256 amount) internal {
        token.mint(to, amount);
    }

    // ------------------------------------------------------------------
    // Time and price
    // ------------------------------------------------------------------

    function warp(uint256 secondsSeed) external checkIndices(false) {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 365 days));
        calls["warp"]++;
    }

    /// @dev Random warps almost never land inside a 60-second lock window, so
    /// without this nearly every round would void and resolution would go
    /// untested. Jumps straight to the next edge the round is waiting on.
    function warpToRoundEdge(uint256 roundSeed) external checkIndices(false) {
        (uint256 roundId, ParimutuelRound.Round memory round) = _round(roundSeed);
        if (roundId == 0) return;
        uint256 target;
        if (round.status == ParimutuelRound.Status.Open) target = round.lockTime;
        else if (round.status == ParimutuelRound.Status.Locked) target = round.closeTime;
        else return;
        if (target <= block.timestamp) return;
        vm.warp(target);
        calls["warpToRoundEdge"]++;
    }

    function movePrice(uint256 priceSeed) external {
        oracle.setPrice(bound(priceSeed, 1_000e18, 3_000e18));
        calls["movePrice"]++;
    }

    // ------------------------------------------------------------------
    // Lenders
    // ------------------------------------------------------------------

    function supply(uint256 lenderSeed, uint256 amountSeed) external checkIndices(false) {
        if (pool.entriesPaused()) return;
        address lender = _lender(lenderSeed);
        uint256 amount = bound(amountSeed, 1, 100_000 * USDC);
        _mint(lender, amount);
        vm.prank(lender);
        pool.supply(amount);
        calls["supply"]++;
    }

    function withdrawSupply(uint256 lenderSeed, uint256 amountSeed) external checkIndices(false) {
        address lender = _lender(lenderSeed);
        pool.accrue();
        uint256 max = Math.min(pool.balanceOfSupply(lender), token.balanceOf(address(pool)));
        if (max == 0) return;
        uint256 amount = bound(amountSeed, 1, max);
        vm.prank(lender);
        pool.withdraw(amount);
        calls["withdrawSupply"]++;
    }

    // ------------------------------------------------------------------
    // Collateral and borrowing
    // ------------------------------------------------------------------

    function deposit(uint256 userSeed, uint256 amountSeed) external checkIndices(false) {
        if (vault.entriesPaused()) return;
        address user = _user(userSeed);
        uint256 amount = bound(amountSeed, 1, 1_000_000 * USDC);
        _mint(user, amount);
        vm.prank(user);
        vault.deposit(amount, user);
        calls["deposit"]++;
    }

    /// @dev With a lien open the vault only allows a full exit that settles
    /// it, so the fraction is ignored in that case.
    function redeem(uint256 userSeed, uint256 fractionSeed) external checkIndices(false) {
        address user = _user(userSeed);
        uint256 held = vault.balanceOf(user);
        if (held == 0) return;
        pool.accrue();
        uint256 lien = vault.lienOf(user);

        uint256 shares = lien == 0 ? Math.max(1, Math.mulDiv(held, bound(fractionSeed, 1, 10_000), 10_000)) : held;
        if (lien != 0 && vault.previewRedeem(shares) < lien) return;

        uint256 vaultBefore = token.balanceOf(address(vault));
        uint256 expectedAssets = vault.previewRedeem(shares);
        vm.prank(user);
        uint256 assets = vault.redeem(shares, user, user);

        assertEq(assets, expectedAssets, "redeem paid other than it previewed");
        assertEq(vaultBefore - token.balanceOf(address(vault)), assets, "vault moved other than the redeemed assets");
        if (lien != 0) assertEq(vault.lienOf(user), 0, "exit left a lien behind");
        calls[lien == 0 ? bytes32("redeem") : bytes32("exitWithLien")]++;
    }

    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 fractionSeed) external checkIndices(false) {
        address from = _user(fromSeed);
        address to = _user(toSeed);
        if (from == to) return;
        uint256 held = vault.balanceOf(from);
        if (held == 0) return;
        pool.accrue();
        if (vault.lienOf(from) != 0) return;
        uint256 shares = Math.max(1, Math.mulDiv(held, bound(fractionSeed, 1, 10_000), 10_000));
        vm.prank(from);
        vault.transfer(to, shares);
        calls["transferShares"]++;
    }

    /// @dev What origination actually guarantees, which is weaker than the
    /// vault's own comment claims.
    ///
    /// The vault checks `lien + amount <= maxDebt` against the amount
    /// *requested*, but the pool rounds scaled debt up, so the debt it
    /// *records* can exceed that by up to ceil(borrowIndex / RAY) wei. At an
    /// index of 2 RAY, borrowing 1 wei records 2. So the LTV cap holds to
    /// within that slack, and "never originates liquidatable" holds only for
    /// positions whose buffer — collateral x (threshold - maxLTV) — is larger
    /// than it: anything above a few micro-USDC. Found by this suite; see the
    /// GHO-19 ADR.
    function _assertOrigination(address user, uint256 lienBefore, uint256 amount) internal view {
        uint256 slack = Math.ceilDiv(pool.borrowIndex(), pool.RAY());
        uint256 collateral = vault.collateralValue(user);
        uint256 lienAfter = vault.lienOf(user);

        assertLe(lienAfter, lienBefore + amount + slack, "borrow recorded more than one scaled unit over the request");
        assertLe(
            lienAfter,
            Math.mulDiv(collateral, vault.maxLTV(), WAD) + slack,
            "borrow originated past maxLTV by more than rounding"
        );
        uint256 buffer = Math.mulDiv(collateral, vault.liquidationThreshold() - vault.maxLTV(), WAD);
        if (buffer > slack) assertGe(vault.healthFactor(user), WAD, "borrow originated liquidatable");
    }

    function borrow(uint256 userSeed, uint256 amountSeed) external checkIndices(false) {
        if (vault.entriesPaused() || pool.entriesPaused()) return;
        address user = _user(userSeed);
        pool.accrue();
        uint256 max = Math.min(vault.maxBorrowable(user), token.balanceOf(address(pool)));
        if (max == 0) return;
        uint256 amount = bound(amountSeed, 1, max);
        uint256 lienBefore = vault.lienOf(user);

        uint256 vaultBefore = token.balanceOf(address(vault));
        vm.prank(user);
        vault.borrow(amount);

        assertEq(token.balanceOf(address(vault)), vaultBefore, "borrowed funds stayed in the vault");
        _assertOrigination(user, lienBefore, amount);
        calls["borrow"]++;
    }

    /// @dev Borrow to the ceiling. Random amounts leave utilization far below
    /// the kink, where interest takes years to reach the liquidation line;
    /// without this the liquidation and write-off paths are unreachable and
    /// the invariants about them pass vacuously.
    function borrowMax(uint256 userSeed) external checkIndices(false) {
        if (vault.entriesPaused() || pool.entriesPaused()) return;
        address user = _user(userSeed);
        pool.accrue();
        uint256 amount = Math.min(vault.maxBorrowable(user), token.balanceOf(address(pool)));
        if (amount == 0) return;
        uint256 lienBefore = vault.lienOf(user);
        vm.prank(user);
        vault.borrow(amount);
        _assertOrigination(user, lienBefore, amount);
        calls["borrowMax"]++;
    }

    /// @dev A liquidity crunch: supply exactly what one borrower can draw, let
    /// them draw all of it, and let time pass at 100% utilization.
    ///
    /// Health only falls when a position sits at the LTV ceiling *and* the
    /// pool is near fully lent, because collateral here cannot grow and only
    /// interest moves the ratio. Either alone does nothing: a borrower capped
    /// by a small pool owes too little to matter, and a borrower at the
    /// ceiling of a deep pool pays the base rate for years. Random sequences
    /// produce both conditions together essentially never, so this builds it.
    function crunch(uint256 userSeed, uint256 lenderSeed, uint256 secondsSeed) external checkIndices(false) {
        if (vault.entriesPaused() || pool.entriesPaused()) return;
        address user = _user(userSeed);
        pool.accrue();
        uint256 headroom = vault.maxBorrowable(user);
        if (headroom == 0) return;

        uint256 cash = token.balanceOf(address(pool));
        if (headroom > cash) {
            address lender = _lender(lenderSeed);
            _mint(lender, headroom - cash);
            vm.prank(lender);
            pool.supply(headroom - cash);
        }
        pool.accrue();
        uint256 amount = Math.min(vault.maxBorrowable(user), token.balanceOf(address(pool)));
        if (amount == 0) return;
        uint256 lienBefore = vault.lienOf(user);
        vm.prank(user);
        vault.borrow(amount);
        _assertOrigination(user, lienBefore, amount);

        vm.warp(block.timestamp + bound(secondsSeed, 30 days, 365 days));
        calls["crunch"]++;
    }

    function repay(uint256 userSeed, uint256 amountSeed) external checkIndices(false) {
        address user = _user(userSeed);
        pool.accrue();
        uint256 lien = vault.lienOf(user);
        if (lien == 0) return;
        uint256 amount = bound(amountSeed, 1, lien);
        _mint(user, amount);

        uint256 vaultBefore = token.balanceOf(address(vault));
        vm.prank(user);
        vault.repay(amount, user);

        assertEq(token.balanceOf(address(vault)), vaultBefore, "repayment stayed in the vault");
        _assertLienFellBy(user, lien, amount);
        calls["repay"]++;
    }

    /// @dev A partial repayment rounds its scaled reduction down, so the lien
    /// can land one scaled unit above `before - paid` — at most
    /// ceil(borrowIndex / RAY) wei, and always in the pool's favour. Never
    /// below: clearing more debt than was paid would be value created.
    function _assertLienFellBy(address user, uint256 before, uint256 paid) internal view {
        uint256 afterLien = vault.lienOf(user);
        uint256 slack = Math.ceilDiv(pool.borrowIndex(), pool.RAY());
        assertGe(afterLien, before - paid, "repayment cleared more debt than was paid");
        assertLe(afterLien, before - paid + slack, "repayment left more than one scaled unit behind");
    }

    function settleYield(uint256 userSeed) external checkIndices(false) {
        vault.settle(_user(userSeed));
        calls["settleYield"]++;
    }

    // ------------------------------------------------------------------
    // Liquidation and bad debt
    // ------------------------------------------------------------------

    function liquidate(uint256 userSeed, uint256 amountSeed) external checkIndices(false) {
        address user = _user(userSeed);
        pool.accrue();
        uint256 max = vault.maxLiquidatableDebt(user);
        if (max == 0) return;
        uint256 amount = bound(amountSeed, 1, max);
        uint256 lienBefore = vault.lienOf(user);
        _mint(liquidator, amount);

        vm.prank(liquidator);
        vault.liquidate(user, amount);

        _assertLienFellBy(user, lienBefore, amount);
        calls["liquidate"]++;
    }

    function writeOffBadDebt(uint256 userSeed) external checkIndices(true) {
        address user = _user(userSeed);
        pool.accrue();
        uint256 debt = vault.lienOf(user);
        if (debt == 0 || debt <= vault.convertToAssets(vault.balanceOf(user))) return;

        vault.writeOffBadDebt(user);

        assertEq(vault.lienOf(user), 0, "write-off left debt standing");
        calls["writeOffBadDebt"]++;
    }

    // ------------------------------------------------------------------
    // Rounds
    // ------------------------------------------------------------------

    function openRound() external {
        if (market.entriesPaused()) return;
        uint256 strike0_ = oracle.price();
        vm.prank(owner);
        market.openRound(
            uint64(block.timestamp),
            uint64(block.timestamp + 10 minutes),
            uint64(block.timestamp + 20 minutes),
            strike0_
        );
        calls["openRound"]++;
    }

    function _entryOpen(ParimutuelRound.Round memory round) internal view returns (bool) {
        return round.status == ParimutuelRound.Status.Open && block.timestamp >= round.openTime
            && block.timestamp < round.lockTime - market.entryCutoff() && !market.entriesPaused();
    }

    function takePosition(uint256 userSeed, uint256 roundSeed, bool up, uint256 amountSeed) external {
        (uint256 roundId, ParimutuelRound.Round memory round) = _round(roundSeed);
        if (roundId == 0 || !_entryOpen(round)) return;
        address user = _user(userSeed);
        // One funding source per user per round.
        if (address(market.settlementSinkOf(roundId, user)) != address(0)) return;

        uint256 amount = bound(amountSeed, 1, 100_000 * USDC);
        _mint(user, amount);
        vm.prank(user);
        market.takePosition(roundId, up ? ParimutuelRound.Side.Up : ParimutuelRound.Side.Down, amount);

        ghost_staked += amount;
        calls["takePosition"]++;
    }

    function openPositionViaRouter(uint256 userSeed, uint256 roundSeed, bool up, uint256 borrowSeed, uint256 ownSeed)
        external
        checkIndices(false)
    {
        (uint256 roundId, ParimutuelRound.Round memory round) = _round(roundSeed);
        if (roundId == 0 || !_entryOpen(round)) return;
        address user = _user(userSeed);

        bool hasStake = market.stakeOf(roundId, user, ParimutuelRound.Side.Up)
            + market.stakeOf(roundId, user, ParimutuelRound.Side.Down) != 0;
        if (hasStake && address(market.settlementSinkOf(roundId, user)) != address(router)) return;

        pool.accrue();
        uint256 borrowAmount;
        if (!vault.entriesPaused() && !pool.entriesPaused()) {
            uint256 maxBorrow = Math.min(vault.maxBorrowable(user), token.balanceOf(address(pool)));
            borrowAmount = bound(borrowSeed, 0, maxBorrow);
        }
        uint256 ownAmount = bound(ownSeed, 0, 100_000 * USDC);
        if (borrowAmount + ownAmount == 0) return;
        _mint(user, ownAmount);

        uint256 vaultBefore = token.balanceOf(address(vault));
        vm.prank(user);
        router.openPosition(roundId, up ? ParimutuelRound.Side.Up : ParimutuelRound.Side.Down, borrowAmount, ownAmount);

        assertEq(token.balanceOf(address(vault)), vaultBefore, "router borrow left funds in the vault");
        ghost_staked += borrowAmount + ownAmount;
        calls["openPositionViaRouter"]++;
    }

    /// @dev A whole round in one call: open, stake both sides (one staker
    /// through the router, on borrowed funds where the pool allows), lock at
    /// the strike, move the price, resolve. Claims are left to `claim` so they
    /// interleave with everything else.
    ///
    /// A round needs a stake on each side above the floor, a warp landing
    /// inside a 60-second lock window, and a second warp past close — a random
    /// sequence almost never assembles that, and without it every market
    /// invariant holds over rounds that never paid anyone.
    function playRound(uint256 seed) external checkIndices(false) {
        if (market.entriesPaused()) return;
        uint256 strike1_ = oracle.price();
        vm.prank(owner);
        uint256 roundId = market.openRound(
            uint64(block.timestamp),
            uint64(block.timestamp + 10 minutes),
            uint64(block.timestamp + 20 minutes),
            strike1_
        );

        uint256 floor = market.minSidePool();
        for (uint256 i = 0; i < 3; i++) {
            // Users 0 and 1 are pinned to opposite sides so both clear the
            // floor; user 2 picks a side from the seed.
            ParimutuelRound.Side side = i == 0
                ? ParimutuelRound.Side.Up
                : i == 1 ? ParimutuelRound.Side.Down : ParimutuelRound.Side(uint8((seed >> 1) & 1));
            uint256 amount = bound(uint256(keccak256(abi.encode(seed, i))), floor, 50_000 * USDC);
            _mint(users[i], amount);
            vm.prank(users[i]);
            market.takePosition(roundId, side, amount);
            ghost_staked += amount;
        }

        // User 3 through the router, borrowing what it can.
        address routed = users[3];
        pool.accrue();
        uint256 borrowAmount;
        if (!vault.entriesPaused() && !pool.entriesPaused()) {
            borrowAmount = Math.min(vault.maxBorrowable(routed), token.balanceOf(address(pool)));
        }
        uint256 own = bound(uint256(keccak256(abi.encode(seed, "own"))), 1, 10_000 * USDC);
        _mint(routed, own);
        vm.prank(routed);
        router.openPosition(roundId, ParimutuelRound.Side(uint8((seed >> 2) & 1)), borrowAmount, own);
        ghost_staked += borrowAmount + own;

        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(round.lockTime);
        market.lockRound(roundId);

        // One in eight rounds is left locked, as if the keeper went down, so
        // late resolution and `voidUnsettledRound` are reachable at all.
        if ((seed >> 5) % 8 == 0) {
            calls["playRoundAbandoned"]++;
            return;
        }

        // One in four rounds ties, which voids on the resolve path.
        uint256 strike = oracle.price();
        uint256 roll = (seed >> 3) % 4;
        oracle.setPrice(roll == 0 ? strike : roll == 1 ? strike - 1 : strike + 1);

        vm.warp(round.closeTime);
        market.resolveRound(roundId, oracle.oracleRoundId());
        calls[market.rounds(roundId).status == ParimutuelRound.Status.Void
            ? bytes32("playRoundTied")
            : bytes32("playRound")]++;
    }

    function lockRound(uint256 roundSeed) external {
        (uint256 roundId, ParimutuelRound.Round memory round) = _round(roundSeed);
        if (roundId == 0 || round.status != ParimutuelRound.Status.Open || block.timestamp < round.lockTime) return;
        market.lockRound(roundId);
        calls[market.rounds(roundId).status == ParimutuelRound.Status.Void
            ? bytes32("lockVoided")
            : bytes32("lockRound")]++;
    }

    function resolveRound(uint256 roundSeed) external {
        (uint256 roundId, ParimutuelRound.Round memory round) = _round(roundSeed);
        if (roundId == 0 || round.status != ParimutuelRound.Status.Locked || block.timestamp < round.closeTime) return;
        market.resolveRound(roundId, oracle.oracleRoundId());
        calls[market.rounds(roundId).status == ParimutuelRound.Status.Void
            ? bytes32("resolveTied")
            : bytes32("resolveRound")]++;
    }

    function voidUnlockedRound(uint256 roundSeed) external {
        (uint256 roundId, ParimutuelRound.Round memory round) = _round(roundSeed);
        if (roundId == 0 || round.status != ParimutuelRound.Status.Open) return;
        if (block.timestamp <= uint256(round.lockTime) + market.lockWindow()) return;
        market.voidUnlockedRound(roundId);
        calls["voidUnlockedRound"]++;
    }

    function voidUnsettledRound(uint256 roundSeed) external {
        (uint256 roundId, ParimutuelRound.Round memory round) = _round(roundSeed);
        if (roundId == 0 || round.status != ParimutuelRound.Status.Locked) return;
        if (block.timestamp <= uint256(round.closeTime) + market.resolveDeadline()) return;
        vm.prank(owner);
        market.voidUnsettledRound(roundId);
        calls["voidUnsettledRound"]++;
    }

    function claim(uint256 roundSeed, uint256 userSeed) external checkIndices(false) {
        (uint256 roundId,) = _round(roundSeed);
        if (roundId == 0) return;
        address user = _user(userSeed);
        uint256 amount = market.claimableOf(roundId, user);
        if (amount == 0) return;

        bool viaRouter = address(market.settlementSinkOf(roundId, user)) == address(router);
        market.claim(roundId, user);

        ghost_paidOut += amount;
        ghost_paidOutOf[roundId] += amount;
        calls[viaRouter ? bytes32("claimViaRouter") : bytes32("claim")]++;
    }

    // ------------------------------------------------------------------
    // Owner and guardian
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // Guards
    // ------------------------------------------------------------------

    /// @dev Tries one forbidden action just past its limit and requires the
    /// exact revert.
    ///
    /// Every positive action above sizes itself from the contract's own views
    /// — `maxBorrowable`, `maxLiquidatableDebt`, `protocolFees` — so a guard
    /// that drifted away from its view would never be reached by them. Moving
    /// the borrow check from maxLTV to the liquidation threshold passed the
    /// whole suite before this existed, because `maxBorrowable` still said
    /// 60% and nothing ever asked for more.
    function probeGuard(uint256 seed, uint256 userSeed) external checkIndices(false) {
        address user = _user(userSeed);
        pool.accrue();
        uint256 which = seed % 5;

        if (which == 0) {
            // One wei over the LTV ceiling.
            if (vault.entriesPaused() || pool.entriesPaused()) return;
            uint256 lien = vault.lienOf(user);
            uint256 ceiling = Math.mulDiv(vault.collateralValue(user), vault.maxLTV(), WAD);
            if (lien > ceiling) return;
            uint256 amount = ceiling - lien + 1;
            vm.expectRevert(
                abi.encodeWithSelector(CollateralVault.ExceedsMaxLTV.selector, user, lien + amount, ceiling)
            );
            vm.prank(user);
            vault.borrow(amount);
            calls["probeBorrowOverCap"]++;
        } else if (which == 1) {
            // Liquidating a healthy position.
            if (vault.lienOf(user) == 0 || vault.isLiquidatable(user)) return;
            vm.expectRevert(
                abi.encodeWithSelector(CollateralVault.PositionNotLiquidatable.selector, user, vault.healthFactor(user))
            );
            vm.prank(liquidator);
            vault.liquidate(user, 1);
            calls["probeLiquidateHealthy"]++;
        } else if (which == 2) {
            // Writing off a position its collateral still covers.
            uint256 debt = vault.lienOf(user);
            uint256 collateral = vault.convertToAssets(vault.balanceOf(user));
            if (debt == 0 || debt > collateral) return;
            vm.expectRevert(
                abi.encodeWithSelector(CollateralVault.PositionIsRecoverable.selector, user, debt, collateral)
            );
            vault.writeOffBadDebt(user);
            calls["probeWriteOffRecoverable"]++;
        } else if (which == 3) {
            // One wei of fees that were never taken — would come out of stakes.
            uint256 fees = market.protocolFees();
            if (token.balanceOf(address(market)) <= fees) return;
            vm.expectRevert(abi.encodeWithSelector(ParimutuelRound.InsufficientFees.selector, fees + 1, fees));
            vm.prank(owner);
            market.withdrawFees(fees + 1);
            calls["probeFeesOverTaken"]++;
        } else {
            // Reserves past the supplier floor.
            uint256 supplied = pool.totalSupplied();
            uint256 balance = token.balanceOf(address(pool));
            uint256 withdrawable = balance > supplied ? balance - supplied : 0;
            uint256 reserves = pool.totalReserves();
            if (reserves <= withdrawable) return;
            vm.expectRevert(
                abi.encodeWithSelector(
                    BorrowLiquidityPool.ReservesSeniorToSuppliers.selector, withdrawable + 1, withdrawable
                )
            );
            vm.prank(owner);
            pool.withdrawReserves(withdrawable + 1);
            calls["probeReservesPastFloor"]++;
        }
    }

    function withdrawFees(uint256 amountSeed) external {
        uint256 fees = market.protocolFees();
        if (fees == 0) return;
        uint256 amount = bound(amountSeed, 1, fees);
        vm.prank(owner);
        market.withdrawFees(amount);
        ghost_feesWithdrawn += amount;
        calls["withdrawFees"]++;
    }

    /// @dev Mirrors the contract's own floor rather than accruing first:
    /// `withdrawReserves` reads the stored index, so the handler must too.
    function withdrawReserves(uint256 amountSeed) external checkIndices(false) {
        uint256 supplied = pool.totalSupplied();
        uint256 balance = token.balanceOf(address(pool));
        uint256 withdrawable = balance > supplied ? balance - supplied : 0;
        uint256 max = Math.min(pool.totalReserves(), withdrawable);
        if (max == 0) return;
        uint256 amount = bound(amountSeed, 1, max);
        vm.prank(owner);
        pool.withdrawReserves(amount);
        calls["withdrawReserves"]++;
    }

    /// @dev Exits carry no pause guard and must never grow one. Pausing here,
    /// with exits filtered on nothing but their own preconditions, is what
    /// tests that under `fail_on_revert`.
    ///
    /// Biased one pause in eight. An even toggle leaves the vault and pool
    /// both open only a quarter of the time, which starves borrowing and
    /// makes every liquidation invariant vacuous.
    function setPause(uint256 seed) external {
        uint256 which = seed % 3;
        bool pause = (seed >> 8) % 8 == 0;
        address target = which == 0 ? address(pool) : which == 1 ? address(vault) : address(market);
        vm.prank(owner);
        (bool ok,) = target.call(abi.encodeWithSignature(pause ? "pauseEntries()" : "unpauseEntries()"));
        assertTrue(ok, "pause toggle reverted");
        calls[pause ? bytes32("pause") : bytes32("unpause")]++;
    }
}
