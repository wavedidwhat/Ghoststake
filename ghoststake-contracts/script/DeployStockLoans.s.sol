// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { BorrowLiquidityPool } from "../src/BorrowLiquidityPool.sol";
import { StockLoanVault, IStockLoanPool } from "../src/StockLoanVault.sol";
import { AggregatorV3Interface } from "../src/interfaces/AggregatorV3Interface.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";

/// @notice GHO-95: the stock-loan pool and vault, for Robinhood Chain testnet.
///
/// Separate from `Deploy` on purpose. The staking stack is already live and
/// nothing here touches it; this adds a second pool (its own lenders, its own
/// bad debt) and the vault that borrows from it.
///
/// Collateral is read from the environment as `<SYM>_TOKEN` / `<SYM>_FEED`
/// pairs for SYM in TSLA, AMZN, AMD, PLTR, NFLX; a symbol with either unset is
/// skipped, and at least one must be given. The feed must already exist —
/// on testnet it is a mirrored `DemoPriceFeed` — and the vault reads its
/// decimals from it.
///
/// `STABLE_ADDRESS` names the borrowed asset; unset deploys a mintable
/// six-decimal `MockUSDC`, which is only ever right on a testnet.
contract DeployStockLoans is Script {
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant N = 5;

    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(key);
        address guardian = vm.envOr("PAUSE_GUARDIAN", deployer);
        address existingStable = vm.envOr("STABLE_ADDRESS", address(0));

        string[N] memory symbols = ["TSLA", "AMZN", "AMD", "PLTR", "NFLX"];
        StockLoanVault.CollateralConfig[] memory cfg = new StockLoanVault.CollateralConfig[](N);
        uint256 count;
        for (uint256 i; i < N; ++i) {
            address token = vm.envOr(string.concat(symbols[i], "_TOKEN"), address(0));
            address feed = vm.envOr(string.concat(symbols[i], "_FEED"), address(0));
            if (token == address(0) || feed == address(0)) continue;
            cfg[count++] = StockLoanVault.CollateralConfig({
                token: IERC20(token),
                feed: AggregatorV3Interface(feed),
                maxLTV: 0.4e18, // stocks gap overnight; well under the 60% staking uses
                liquidationThreshold: 0.55e18,
                liquidationBonus: 0.08e18,
                maxAge: 1 days,
                liquidationMaxAge: 5 days, // a long weekend is inside it
                scaledUI: true // Robinhood `Stock` exposes uiMultiplier()
             });
        }
        require(count != 0, "no <SYM>_TOKEN/<SYM>_FEED pair set");
        // Trim the unused tail: the vault takes exactly the configs it is given.
        assembly {
            mstore(cfg, count)
        }

        vm.startBroadcast(key);

        IERC20 stable = existingStable == address(0) ? IERC20(address(new MockUSDC())) : IERC20(existingStable);

        BorrowLiquidityPool pool = new BorrowLiquidityPool(
            stable,
            _perSecond(3), // base 3% APR: a stock loan is riskier than the staking pool's 2%
            _perSecond(9),
            _perSecond(100),
            0.8e18,
            0.2e18, // 20% of interest to reserves: this pool's bad-debt buffer
            deployer,
            guardian
        );

        StockLoanVault vault = new StockLoanVault(
            IStockLoanPool(address(pool)),
            cfg,
            0.005e18, // 0.5% origination
            0.25e18, // a quarter of the liquidation bonus to the treasury
            0.5e18,
            guardian
        );
        pool.setBorrowModule(address(vault));

        vm.stopBroadcast();

        console2.log("STOCK_STABLE=%s", address(stable));
        console2.log("STOCK_POOL=%s", address(pool));
        console2.log("STOCK_VAULT=%s", address(vault));
        console2.log("STOCK_COLLATERALS=%s", count);
    }

    function _perSecond(uint256 aprPercent) internal pure returns (uint256) {
        return (aprPercent * WAD) / 100 / YEAR;
    }
}
