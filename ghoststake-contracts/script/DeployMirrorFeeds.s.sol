// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { DemoPriceFeed } from "../src/demo/DemoPriceFeed.sol";

/// @notice GHO-95: one mirrored `DemoPriceFeed` per stock, for the stock-loan
/// vault to price against.
///
/// Each is labelled for what it carries, exactly as the RHTSLA feed is — the
/// label is the only place anyone is told the price crossed a bridge. Seeded
/// from `<SYM>_SEED_PRICE` (the mainnet price, 8 decimals, read with `cast`
/// beforehand) and backdated by `FEED_SEED_AGE`, for the reason given in
/// `Deploy.s.sol`: a seed stamped "now" leaves the mirror waiting on a source
/// whose newest print is older than it.
///
/// Symbols with no `<SYM>_SEED_PRICE` are skipped.
contract DeployMirrorFeeds is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(key);
        uint256 seedAge = vm.envOr("FEED_SEED_AGE", uint256(86_400));

        string[4] memory symbols = ["AMZN", "AMD", "PLTR", "TSLA"];

        vm.startBroadcast(key);
        for (uint256 i; i < symbols.length; ++i) {
            uint256 price = vm.envOr(string.concat(symbols[i], "_SEED_PRICE"), uint256(0));
            if (price == 0) continue;
            DemoPriceFeed feed = new DemoPriceFeed(
                8, string.concat("RH", symbols[i], " / USD (mirrored from Robinhood Chain mainnet)"), deployer
            );
            feed.pushAt(int256(price), block.timestamp - seedAge);
            console2.log(string.concat(symbols[i], "_FEED=%s"), address(feed));
        }
        vm.stopBroadcast();
    }
}
