// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice An ERC-777-shaped asset: it hands control to a registered hook on
/// every transfer, before the balances settle back. This is the token that
/// turns "check-effects-interactions" from a style preference into the thing
/// standing between the protocol and a drain.
///
/// The stack is not deployed against a token like this — the deployment asset
/// is a plain ERC-20 — but a future market on a hooked asset would be, and the
/// reentrancy guards are the only reason that would still be safe. These tests
/// pin that.
contract HookedToken is ERC20 {
    address public hook;
    bool public armed;
    /// @dev Which transfer of the outer call to fire on, 1-indexed. Lets a
    /// test aim the callback at a specific window inside a multi-transfer
    /// operation rather than always the first one.
    uint256 public fireOn = 1;
    uint256 public seen;

    constructor() ERC20("Hooked", "HOOK") { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHook(address hook_) external {
        hook = hook_;
    }

    function arm(bool value) external {
        armed = value;
        seen = 0;
    }

    function armAt(uint256 nth) external {
        armed = true;
        fireOn = nth;
        seen = 0;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && hook != address(0)) {
            seen += 1;
            if (seen != fireOn) return;
            armed = false; // one shot: the callback must not recurse forever
            (bool ok, bytes memory data) = hook.call(abi.encodeWithSignature("tokensReceived()"));
            // Surface the inner revert so the test can see what stopped it.
            if (!ok) {
                assembly {
                    revert(add(data, 32), mload(data))
                }
            }
        }
    }
}
