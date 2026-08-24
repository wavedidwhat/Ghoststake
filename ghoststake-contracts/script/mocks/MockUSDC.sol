// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A stand-in for USDC on a local chain. Six decimals, mintable by
/// anyone.
///
/// Six on purpose, not eighteen. Every other asset in this repo's tests is an
/// 18-decimal mock, which is exactly the assumption that hid a 10^12 display
/// bug in the frontend until the fourth audit. Deploying against a 6-decimal
/// asset is the only way to prove that fix outside a unit test.
///
/// Lives under `script/` rather than `src/`: it is deployment scaffolding for
/// a local chain and must never reach a real one.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin", "mUSDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @dev Open mint. Fine on a disposable chain, catastrophic anywhere else.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
