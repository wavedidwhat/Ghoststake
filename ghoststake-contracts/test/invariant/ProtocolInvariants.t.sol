// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { console } from "forge-std/console.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { BorrowLiquidityPool } from "../../src/BorrowLiquidityPool.sol";
import { BorrowToPositionRouter } from "../../src/BorrowToPositionRouter.sol";
import { CollateralVault, ILienSource } from "../../src/CollateralVault.sol";
import { ParimutuelRound, IRoundOracle } from "../../src/ParimutuelRound.sol";
import { MockRoundOracle } from "../mocks/MockRoundOracle.sol";
import { MockUSDC } from "../../script/mocks/MockUSDC.sol";
import { ProtocolHandler } from "./ProtocolHandler.sol";

/// @notice GHO-19: the properties that must hold whatever sequence of calls
/// happens, across all three contracts at once.
///
/// Deployed with `Deploy.s.sol`'s own parameters and a 6-decimal asset, so the
/// system being fuzzed is the one on Sepolia rather than a friendlier one.
/// Rounding is the usual way these properties break, and rounding bites
/// hardest at 6 decimals.
contract ProtocolInvariantsTest is StdInvariant, Test {
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant WAD = 1e18;

    BorrowLiquidityPool internal pool;
    CollateralVault internal vault;
    ParimutuelRound internal market;
    BorrowToPositionRouter internal router;
    MockRoundOracle internal oracle;
    MockUSDC internal token;
    ProtocolHandler internal handler;

    address internal owner = makeAddr("owner");
    address[] internal users;
    address[] internal lenders;

    function perSecond(uint256 aprPercent) internal pure returns (uint256) {
        return (aprPercent * WAD) / 100 / YEAR;
    }

    function setUp() public {
        token = new MockUSDC();

        pool = new BorrowLiquidityPool(
            IERC20(address(token)), perSecond(2), perSecond(8), perSecond(100), 0.8e18, 0.1e18, owner, owner
        );
        vault = new CollateralVault(
            IERC20(address(token)),
            perSecond(5),
            ILienSource(address(pool)),
            CollateralVault.RiskParams({
                maxLTV: 0.6e18,
                liquidationThreshold: 0.8e18,
                liquidationBonus: 0.05e18,
                closeFactor: 0.5e18
            }),
            owner
        );
        vm.prank(owner);
        pool.setBorrowModule(address(vault));

        oracle = new MockRoundOracle(2000e18);
        market = new ParimutuelRound(
            IERC20(address(token)),
            IRoundOracle(address(oracle)),
            0.02e18,
            ParimutuelRound.Timing({ entryCutoff: 15 seconds, lockWindow: 60 seconds, resolveDeadline: 1 hours }),
            10e6,
            owner,
            owner
        );
        router = new BorrowToPositionRouter(vault, market);
        vm.prank(owner);
        market.setRouter(address(router), true);

        for (uint256 i = 0; i < 5; i++) {
            users.push(makeAddr(string.concat("user", vm.toString(i))));
        }
        for (uint256 i = 0; i < 2; i++) {
            lenders.push(makeAddr(string.concat("lender", vm.toString(i))));
        }

        handler = new ProtocolHandler(pool, vault, market, router, oracle, token, owner, users, lenders);

        for (uint256 i = 0; i < users.length; i++) {
            vm.startPrank(users[i]);
            token.approve(address(vault), type(uint256).max);
            token.approve(address(market), type(uint256).max);
            token.approve(address(router), type(uint256).max);
            vault.approveBorrowDelegate(address(router), type(uint256).max);
            vm.stopPrank();
        }
        for (uint256 i = 0; i < lenders.length; i++) {
            vm.prank(lenders[i]);
            token.approve(address(pool), type(uint256).max);
        }
        vm.prank(handler.liquidator());
        token.approve(address(vault), type(uint256).max);

        targetContract(address(handler));
    }

    // ------------------------------------------------------------------
    // Lending pool
    // ------------------------------------------------------------------

    /// @notice What the pool holds and is owed covers everything it owes, to
    /// within one wei per debt reduction.
    ///
    /// Cash plus outstanding debt on one side; supplier claims plus the
    /// protocol's reserves on the other. Unsocialised bad debt is added to the
    /// assets side because it is, by construction, a loss the pool recorded
    /// with nobody left to charge — the one shortfall the books admit to.
    ///
    /// The tolerance is a finding, not a fudge. Debt is held in scaled units
    /// worth `borrowIndex / RAY` wei each, but read back rounded down, so
    /// clearing a position's units in full collects the floor and forgives the
    /// fraction. The deep campaign reached a 1-wei shortfall this way after a
    /// full exit at an index where nothing else had built slack. Bounding it by
    /// the count of reductions means a real leak — anything that loses more
    /// than rounding — still fails.
    function invariant_poolIsSolventWithinRounding() public view {
        uint256 assets = token.balanceOf(address(pool)) + pool.totalBorrowed() + pool.unsocialisedBadDebt();
        uint256 liabilities = pool.totalSupplied() + pool.totalReserves();
        assertGe(assets + handler.ghost_debtReductions(), liabilities, "pool is short by more than rounding");
    }

    /// @notice Scaled totals are the sum of scaled balances, exactly.
    function invariant_scaledTotalsAreSums() public view {
        uint256 debt;
        for (uint256 i = 0; i < users.length; i++) {
            debt += pool.scaledDebt(users[i]);
        }
        uint256 supply;
        for (uint256 i = 0; i < lenders.length; i++) {
            supply += pool.scaledSupply(lenders[i]);
        }
        assertEq(pool.totalBorrowScaled(), debt, "totalBorrowScaled drifted from the sum of debts");
        assertEq(pool.totalSupplyScaled(), supply, "totalSupplyScaled drifted from the sum of supplies");
    }

    /// @notice In asset units the total can exceed the sum only by rounding:
    /// each balance floors on its own, so at most one wei per borrower.
    function invariant_totalDebtIsSumOfDebtsWithinRounding() public view {
        uint256 sum;
        for (uint256 i = 0; i < users.length; i++) {
            sum += pool.balanceOfDebt(users[i]);
        }
        uint256 total = pool.totalBorrowed();
        assertGe(total, sum, "individual debts exceed the total");
        assertLe(total - sum, users.length, "total debt exceeds the sum by more than rounding");
    }

    function invariant_borrowIndexNeverFalls() public view {
        assertFalse(handler.ghost_borrowIndexFell(), "borrow index fell");
    }

    /// @notice The supply index is a claim on the pool and is written down by
    /// bad debt on purpose. Anywhere else, a fall is a loss nobody recorded.
    function invariant_supplyIndexFallsOnlyOnWriteOff() public view {
        assertFalse(handler.ghost_supplyIndexFellOutsideWriteOff(), "supply index fell outside a write-off");
    }

    // ------------------------------------------------------------------
    // Vault
    // ------------------------------------------------------------------

    function invariant_sharesAreConserved() public view {
        uint256 sum;
        for (uint256 i = 0; i < users.length; i++) {
            sum += vault.balanceOf(users[i]);
        }
        assertEq(vault.totalSupply(), sum, "shares exist outside the users who hold them");
    }

    /// @notice Every holder can redeem at once and the vault can pay.
    function invariant_vaultCanPayEveryHolder() public view {
        uint256 owed;
        for (uint256 i = 0; i < users.length; i++) {
            owed += vault.previewRedeem(vault.balanceOf(users[i]));
        }
        assertLe(owed, token.balanceOf(address(vault)), "vault cannot cover every redemption");
    }

    /// @notice The ledger travels with the shares: no shares, no position.
    function invariant_noPositionWithoutShares() public view {
        for (uint256 i = 0; i < users.length; i++) {
            if (vault.balanceOf(users[i]) != 0) continue;
            (uint256 principal,,, uint256 settledYield) = vault.positions(users[i]);
            assertEq(principal, 0, "principal survives with no shares");
            assertEq(settledYield, 0, "yield survives with no shares");
        }
    }

    /// @notice Every underwater position can actually be closed.
    ///
    /// "Debt never exceeds collateral times the threshold, except before
    /// liquidation" is true of any system by definition and tests nothing. The
    /// real property is liveness: once a position is liquidatable, some caller
    /// can end it — a liquidator while collateral covers the debt, a write-off
    /// once it does not. Tried against a snapshot so the probe leaves no trace.
    function invariant_underwaterPositionsCanBeClosed() public {
        uint256 snapshot = vm.snapshotState();
        pool.accrue();
        address liquidator = handler.liquidator();

        for (uint256 i = 0; i < users.length; i++) {
            address user = users[i];
            if (!vault.isLiquidatable(user)) continue;

            uint256 debt = vault.lienOf(user);
            uint256 seizable = vault.convertToAssets(vault.balanceOf(user));
            if (debt > seizable) {
                vault.writeOffBadDebt(user);
                assertEq(vault.lienOf(user), 0, "write-off left debt standing");
                continue;
            }

            uint256 max = vault.maxLiquidatableDebt(user);
            token.mint(liquidator, max);
            vm.prank(liquidator);
            vault.liquidate(user, max);

            // A repayment worth less than one scaled unit clears no units at
            // all, so the liquidator pays, collateral is seized, and the lien
            // does not move. Reached by the deep campaign at an index of 8.37
            // RAY: a 16-wei lien, close factor capping the repayment at 8 wei,
            // and 8 / 8.37 rounding to zero. The position is not stuck — the
            // seizure drops it below the full-liquidation line and the next
            // call closes it — but this one call is a transfer from borrower to
            // pool. Allowed only in exactly that case.
            if (vault.lienOf(user) >= debt) {
                assertLt(max, Math.ceilDiv(pool.borrowIndex(), pool.RAY()), "liquidation cleared nothing");
            }
        }

        vm.revertToState(snapshot);
    }

    function invariant_routerHoldsNothing() public view {
        assertEq(token.balanceOf(address(router)), 0, "router kept funds between transactions");
    }

    // ------------------------------------------------------------------
    // Market
    // ------------------------------------------------------------------

    /// @notice A round never pays out more than it is allowed to: the pool
    /// less rake once resolved, the pool itself once void, nothing before.
    function invariant_roundNeverOverpays() public view {
        uint256 count = market.roundCount();
        for (uint256 id = 1; id <= count; id++) {
            ParimutuelRound.Round memory round = market.rounds(id);
            uint256 pool_ = round.upPool + round.downPool;
            uint256 paid = handler.ghost_paidOutOf(id);
            if (round.status == ParimutuelRound.Status.Resolved) {
                assertLe(paid, pool_ - round.rakeTaken, "resolved round paid more than pool minus rake");
            } else if (round.status == ParimutuelRound.Status.Void) {
                assertLe(paid, pool_, "void round refunded more than was staked");
                assertEq(round.rakeTaken, 0, "void round took rake");
            } else {
                assertEq(paid, 0, "unsettled round paid out");
            }
        }
    }

    /// @notice The market's balance is exactly what came in less what went
    /// out. No other flow exists, so any difference is value created or lost.
    function invariant_marketCashIsConserved() public view {
        assertEq(
            token.balanceOf(address(market)),
            handler.ghost_staked() - handler.ghost_paidOut() - handler.ghost_feesWithdrawn(),
            "market balance does not match its cash flows"
        );
    }

    /// @notice Fees on the books are the rake actually taken, less what left.
    function invariant_feesAreTheRakeTaken() public view {
        uint256 raked;
        uint256 count = market.roundCount();
        for (uint256 id = 1; id <= count; id++) {
            raked += market.rounds(id).rakeTaken;
        }
        assertEq(market.protocolFees() + handler.ghost_feesWithdrawn(), raked, "fees do not match rake taken");
    }

    /// @notice The market can always pay every outstanding claim and its
    /// fees at once. Resolved rounds may keep up to one wei per winner as
    /// floor-division dust, which is the direction that keeps this true.
    function invariant_marketCoversEverythingItOwes() public view {
        uint256 owed = market.protocolFees();
        uint256 count = market.roundCount();
        for (uint256 id = 1; id <= count; id++) {
            ParimutuelRound.Round memory round = market.rounds(id);
            uint256 pool_ = round.upPool + round.downPool;
            uint256 paid = handler.ghost_paidOutOf(id);
            if (round.status == ParimutuelRound.Status.Resolved) {
                for (uint256 i = 0; i < users.length; i++) {
                    owed += market.claimableOf(id, users[i]);
                }
            } else {
                owed += pool_ - paid;
            }
        }
        assertGe(token.balanceOf(address(market)), owed, "market cannot cover what it owes");
    }

    // ------------------------------------------------------------------
    // Coverage
    // ------------------------------------------------------------------

    /// @dev Forge prints this for one run only, so it cannot show coverage
    /// across a campaign. With `GHO19_COVERAGE=1` each run appends its counts
    /// to a file instead; see the runbook for the one-liner that sums them.
    function _trim(bytes32 name) internal pure returns (string memory) {
        uint256 length;
        while (length < 32 && name[length] != 0) length++;
        bytes memory out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = name[i];
        }
        return string(out);
    }

    function afterInvariant() public {
        bytes32[36] memory names = [
            bytes32("supply"),
            "withdrawSupply",
            "deposit",
            "redeem",
            "exitWithLien",
            "transferShares",
            "borrow",
            "borrowMax",
            "crunch",
            "repay",
            "liquidate",
            "writeOffBadDebt",
            "openRound",
            "takePosition",
            "openPositionViaRouter",
            "lockRound",
            "lockVoided",
            "resolveRound",
            "resolveTied",
            "voidUnlockedRound",
            "voidUnsettledRound",
            "claim",
            "claimViaRouter",
            "withdrawFees",
            "withdrawReserves",
            "pause",
            "unpause",
            "warpToRoundEdge",
            "playRound",
            "playRoundTied",
            "playRoundAbandoned",
            "probeBorrowOverCap",
            "probeLiquidateHealthy",
            "probeWriteOffRecoverable",
            "probeFeesOverTaken",
            "probeReservesPastFloor"
        ];
        bool toFile = vm.envOr("GHO19_COVERAGE", false);
        for (uint256 i = 0; i < names.length; i++) {
            string memory line = string.concat(_trim(names[i]), " ", vm.toString(handler.calls(names[i])));
            if (toFile) vm.writeLine("cache/invariant-coverage.txt", line);
            else console.log(line);
        }
    }
}
