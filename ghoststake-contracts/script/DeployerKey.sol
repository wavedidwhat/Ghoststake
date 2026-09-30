// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Which key a script signs with when `PRIVATE_KEY` may be unset.
///
/// Both `Deploy` and `Seed` fell back to anvil's first account when the
/// variable was missing, on any chain. That key is printed by every anvil
/// install, so a broadcast against a real RPC with the variable forgotten
/// would have made a public key the owner of every contract it deployed —
/// the treasury, the reserves, the routers, the arbiter. It most likely fails
/// for gas first, because sweeper bots keep that address empty; "most likely"
/// is not a guard. The fallback is now what it always claimed to be: local
/// only.
abstract contract DeployerKey {
    uint256 internal constant ANVIL_KEY_0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant ANVIL_CHAIN_ID = 31337;

    error PrivateKeyRequired(uint256 chainId);

    /// @param fromEnv `vm.envOr("PRIVATE_KEY", uint256(0))`.
    function _deployerKey(uint256 fromEnv) internal view returns (uint256) {
        if (fromEnv != 0) return fromEnv;
        if (block.chainid != ANVIL_CHAIN_ID) revert PrivateKeyRequired(block.chainid);
        return ANVIL_KEY_0;
    }
}
