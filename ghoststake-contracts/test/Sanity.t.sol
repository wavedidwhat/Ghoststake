// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import { Test } from "forge-std/Test.sol";

/// @notice Placeholder so `forge test` is green on a fresh clone. Delete once
/// real contracts and tests land.
contract SanityTest is Test {
    function test_toolchainWorks() public pure {
        assertEq(uint256(1 + 1), uint256(2));
    }
}
