// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";
import { BorrowToPositionRouter } from "../src/BorrowToPositionRouter.sol";
import { CollateralVault, ILienSource } from "../src/CollateralVault.sol";
import { EntryPausable } from "../src/EntryPausable.sol";
import { ParimutuelRound, IRoundOracle } from "../src/ParimutuelRound.sol";
import { MockRoundOracle } from "./mocks/MockRoundOracle.sol";

/// @notice GHO-31: an emergency stop that can only stop people arriving.
///
/// Half of this file asserts that entries close. The other half asserts that
/// exits do not, and that half is the one that matters — a pause which can
/// trap funds is a different product from one that can refuse them, and only
/// the second is defensible. Every exit is tested individually and while
/// paused, because "we were careful" is not a property.
contract EmergencyStopTest is Test {
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant FIVE_PERCENT_APR = uint256(5e16) / YEAR;

    BorrowLiquidityPool internal pool;
    CollateralVault internal vault;
    ParimutuelRound internal market;
    BorrowToPositionRouter internal router;
    MockRoundOracle internal oracle;
    ERC20Mock internal token;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal lender = makeAddr("lender");
    address internal alice = makeAddr("alice");
    address internal carol = makeAddr("carol");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        token = new ERC20Mock();

        pool = new BorrowLiquidityPool(
            IERC20(address(token)), 0, uint256(4e16) / YEAR, uint256(75e16) / YEAR, 8e17, 1e17, owner, guardian
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
            guardian
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
            guardian
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

    function _pauseAll() internal {
        vm.startPrank(guardian);
        vault.pauseEntries();
        pool.pauseEntries();
        market.pauseEntries();
        vm.stopPrank();
    }

    function _openRound() internal returns (uint256 roundId) {
        vm.prank(owner);
        roundId = market.openRound(
            uint64(block.timestamp), uint64(block.timestamp + 10 minutes), uint64(block.timestamp + 20 minutes)
        );
    }

    // ---------------------------------------------------------------
    // Entries close
    // ---------------------------------------------------------------

    function test_pausedVaultRefusesDepositsAndMints() public {
        _pauseAll();

        vm.expectRevert(EntryPausable.EntriesArePaused.selector);
        vm.prank(alice);
        vault.deposit(100 ether, alice);

        // Guarded at `_deposit` rather than on the two public functions, so
        // `mint` is covered by the same guard rather than by remembering.
        vm.expectRevert(EntryPausable.EntriesArePaused.selector);
        vm.prank(alice);
        vault.mint(100 ether, alice);
    }

    function test_pausedVaultRefusesBorrowsFromBothEntryPoints() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        vm.prank(alice);
        vault.approveBorrowDelegate(carol, 500 ether);

        _pauseAll();

        vm.expectRevert(EntryPausable.EntriesArePaused.selector);
        vm.prank(alice);
        vault.borrow(100 ether);

        // The delegated path too: a pause that stopped one but not the other
        // would leave the router as an open door into a halted protocol.
        vm.expectRevert(EntryPausable.EntriesArePaused.selector);
        vm.prank(carol);
        vault.borrowFor(alice, 100 ether);
    }

    function test_pausedPoolRefusesSupply() public {
        _pauseAll();

        vm.expectRevert(EntryPausable.EntriesArePaused.selector);
        vm.prank(lender);
        pool.supply(1_000 ether);
    }

    function test_pausedMarketRefusesNewRoundsAndNewPositions() public {
        uint256 roundId = _openRound();
        _pauseAll();

        vm.expectRevert(EntryPausable.EntriesArePaused.selector);
        vm.prank(owner);
        market.openRound(
            uint64(block.timestamp), uint64(block.timestamp + 10 minutes), uint64(block.timestamp + 20 minutes)
        );

        vm.expectRevert(EntryPausable.EntriesArePaused.selector);
        vm.prank(alice);
        market.takePosition(roundId, ParimutuelRound.Side.Up, 10 ether);
    }

    /// The borrow-to-position path crosses all three contracts, so it is the
    /// one that would slip through a partial pause.
    function test_pausedProtocolRefusesTheBorrowToPositionPath() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        vm.prank(alice);
        vault.approveBorrowDelegate(address(router), 500 ether);
        uint256 roundId = _openRound();

        _pauseAll();

        vm.expectRevert(EntryPausable.EntriesArePaused.selector);
        vm.prank(alice);
        router.openPosition(roundId, ParimutuelRound.Side.Up, 300 ether, 0);
    }

    // ---------------------------------------------------------------
    // Exits stay open — the half that matters
    // ---------------------------------------------------------------

    function test_pausedVaultStillLetsYouLeave() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);

        _pauseAll();

        vm.prank(alice);
        vault.withdraw(400 ether, alice, alice);
        // Hoisted: an argument is evaluated before the call it belongs to, so
        // a prank spent on `balanceOf` sends the redeem from the test
        // contract, which holds no shares.
        uint256 half = vault.balanceOf(alice) / 2;
        vm.prank(alice);
        vault.redeem(half, alice, alice);

        assertGt(token.balanceOf(alice), 0, "assets came back out while paused");
    }

    function test_pausedProtocolStillAcceptsRepayment() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        vm.prank(alice);
        vault.borrow(300 ether);

        _pauseAll();

        uint256 debt = vault.lienOf(alice);
        vm.prank(alice);
        vault.repay(debt, alice);
        assertEq(vault.lienOf(alice), 0, "repayment refused while paused");
    }

    /// Pausing liquidation would be worse than useless: it lets underwater
    /// positions sit and rot, which is how a temporary problem becomes the
    /// permanent one GHO-45 had to build a mechanism for.
    function test_pausedProtocolStillLiquidates() public {
        _driveAliceUnderwater(2);
        _pauseAll();

        assertTrue(vault.isLiquidatable(alice), "setup");
        uint256 repay = vault.maxLiquidatableDebt(alice);
        vm.prank(keeper);
        vault.liquidate(alice, repay);

        assertLt(vault.lienOf(alice), type(uint256).max);
        assertGt(token.balanceOf(keeper), 0, "liquidator was paid while paused");
    }

    /// Same argument one step further along: a halt that blocked recognition
    /// would leave the pool's books overstated for the duration.
    function test_pausedProtocolStillWritesOffBadDebt() public {
        _driveAliceUnderwater(6);
        _pauseAll();

        vm.prank(keeper);
        vault.writeOffBadDebt(alice);
        assertEq(vault.lienOf(alice), 0, "write-off refused while paused");
    }

    function test_pausedPoolStillLetsSuppliersWithdrawAndAccrue() public {
        _pauseAll();

        pool.accrue(); // permissionless, and everything else depends on it

        vm.prank(lender);
        pool.withdraw(1_000 ether);
        assertGt(token.balanceOf(lender), 0, "supplier could not exit while paused");
    }

    /// A share transfer is neither an entry nor an exit — it moves a claim
    /// between two people who already hold one. Blocking it would trap value
    /// without refusing any, which is the wrong side of the line.
    function test_pausedVaultStillTransfersShares() public {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);

        _pauseAll();

        vm.prank(alice);
        vault.transfer(carol, 100);
        assertEq(vault.balanceOf(carol), 100, "share transfer refused while paused");
    }

    /// An open round has to be able to finish. A halt that stranded one would
    /// trap every stake in it behind an operator's judgement, which is exactly
    /// the hostage-taking an entry-only pause exists to rule out.
    function test_pausedMarketStillSettlesAnOpenRoundAndPaysOut() public {
        uint256 roundId = _openRound();
        vm.prank(alice);
        market.takePosition(roundId, ParimutuelRound.Side.Up, 100 ether);
        vm.prank(carol);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 100 ether);

        _pauseAll();

        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(round.lockTime);
        market.lockRound(roundId);

        oracle.setPrice(2100e18);
        uint80 closeRound = oracle.oracleRoundId();
        vm.warp(uint256(round.closeTime) + 1);
        market.resolveRound(roundId, closeRound);

        uint256 before = token.balanceOf(alice);
        market.claim(roundId, alice);
        assertGt(token.balanceOf(alice), before, "winner could not claim while paused");
    }

    /// The owner's last-resort unwind, which must also survive a halt — it is
    /// the only way a round nobody resolved gives the stakes back.
    function test_pausedMarketStillVoidsAnUnsettledRound() public {
        uint256 roundId = _openRound();
        vm.prank(alice);
        market.takePosition(roundId, ParimutuelRound.Side.Up, 100 ether);
        vm.prank(carol);
        market.takePosition(roundId, ParimutuelRound.Side.Down, 100 ether);

        ParimutuelRound.Round memory round = market.rounds(roundId);
        vm.warp(round.lockTime);
        market.lockRound(roundId);

        _pauseAll();

        vm.warp(uint256(round.closeTime) + 2 hours);
        vm.prank(owner);
        market.voidUnsettledRound(roundId);

        uint256 before = token.balanceOf(alice);
        market.claim(roundId, alice);
        assertGt(token.balanceOf(alice), before, "refund refused while paused");
    }

    // ---------------------------------------------------------------
    // The guardian role
    // ---------------------------------------------------------------

    function test_onlyTheGuardianMayPause() public {
        vm.expectRevert(abi.encodeWithSelector(EntryPausable.NotPauseGuardian.selector, alice));
        vm.prank(alice);
        vault.pauseEntries();

        // Not even the owner, where there is one. The roles are separate on
        // purpose: pausing is the four-in-the-morning key, and it should not
        // be the one that can also move reserves.
        vm.expectRevert(abi.encodeWithSelector(EntryPausable.NotPauseGuardian.selector, owner));
        vm.prank(owner);
        pool.pauseEntries();
    }

    function test_pauseIsReversible() public {
        _pauseAll();
        vm.prank(guardian);
        vault.unpauseEntries();

        vm.prank(alice);
        vault.deposit(100 ether, alice);
        assertGt(vault.balanceOf(alice), 0, "entries did not reopen");
    }

    function test_guardianCanBeRotated() public {
        address successor = makeAddr("successor");
        vm.prank(guardian);
        vault.transferPauseGuardian(successor);

        vm.expectRevert(abi.encodeWithSelector(EntryPausable.NotPauseGuardian.selector, guardian));
        vm.prank(guardian);
        vault.pauseEntries();

        vm.prank(successor);
        vault.pauseEntries();
        assertTrue(vault.entriesPaused());
    }

    /// Handing the role to nobody mid-pause would leave entries refused
    /// forever, with no address in existence that could lift it.
    function test_theRoleCannotBeRenouncedWhilePaused() public {
        _pauseAll();

        vm.expectRevert(EntryPausable.CannotRenounceWhilePaused.selector);
        vm.prank(guardian);
        vault.transferPauseGuardian(address(0));
    }

    /// Renouncing while open is a legitimate act: a protocol declaring that it
    /// can no longer be halted. It is also the only irreversible one here.
    function test_renouncingMakesTheProtocolPermanentlyUnpausable() public {
        vm.prank(guardian);
        vault.transferPauseGuardian(address(0));

        vm.expectRevert(abi.encodeWithSelector(EntryPausable.NotPauseGuardian.selector, guardian));
        vm.prank(guardian);
        vault.pauseEntries();

        vm.prank(alice);
        vault.deposit(100 ether, alice);
        assertGt(vault.balanceOf(alice), 0, "deposits still work with no guardian");
    }

    /// Each contract pauses on its own. Deliberate: a shared guardian contract
    /// would put an external call on every deposit in the protocol, and a bug
    /// or misconfiguration there breaks entries everywhere — the failure the
    /// pause exists to avoid, arriving through the pause itself.
    function test_theThreeContractsPauseIndependently() public {
        vm.prank(guardian);
        pool.pauseEntries();

        assertTrue(pool.entriesPaused());
        assertFalse(vault.entriesPaused(), "the vault was halted by the pool's pause");

        // Depositing still works; only new supply is refused.
        vm.prank(alice);
        vault.deposit(100 ether, alice);
        assertGt(vault.balanceOf(alice), 0);
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    /// @dev Every argument hoisted out of its prank: an argument is evaluated
    /// before the call it belongs to, so a prank spent on a view sends the
    /// transaction from the test contract.
    function _driveAliceUnderwater(uint256 yearsElapsed) internal {
        vm.prank(alice);
        vault.deposit(1_000 ether, alice);
        uint256 ceiling = vault.maxBorrowable(alice);
        vm.prank(alice);
        vault.borrow(ceiling);

        vm.prank(carol);
        vault.deposit(1_000_000 ether, carol);
        vm.prank(carol);
        vault.borrow(450_000 ether);

        vm.warp(block.timestamp + yearsElapsed * YEAR);
        pool.accrue();
    }
}
