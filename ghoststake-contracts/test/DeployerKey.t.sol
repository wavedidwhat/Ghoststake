// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { DeployerKey } from "../script/DeployerKey.sol";

contract DeployerKeyHarness is DeployerKey {
    function key(uint256 fromEnv) external view returns (uint256) {
        return _deployerKey(fromEnv);
    }
}

/// Audit 2026-09-30: `Deploy` and `Seed` signed with anvil's public key
/// whenever PRIVATE_KEY was unset, on any chain.
contract DeployerKeyTest is Test {
    DeployerKeyHarness internal harness = new DeployerKeyHarness();

    function test_unsetKeyOnAnvilUsesAnvilAccountZero() public {
        vm.chainId(31337);
        assertEq(vm.addr(harness.key(0)), 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266);
    }

    function test_unsetKeyOffAnvilRefusesRatherThanSigningWithAPublicKey() public {
        vm.chainId(46630); // Robinhood Chain testnet
        vm.expectRevert(abi.encodeWithSelector(DeployerKey.PrivateKeyRequired.selector, 46630));
        harness.key(0);
    }

    function test_aSuppliedKeyIsUsedOnAnyChain() public {
        vm.chainId(46630);
        assertEq(harness.key(0xBEEF), 0xBEEF);
    }
}
