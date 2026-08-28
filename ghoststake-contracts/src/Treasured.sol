// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice A named destination for protocol earnings, so that where the money
/// goes is a stored fact rather than a transaction parameter.
///
/// # What this replaces
///
/// `withdrawFees(address to, uint256 amount)` and
/// `withdrawReserves(address to, uint256 amount)` both took the destination as
/// an argument, validated only as non-zero. There was no treasury address
/// anywhere in the system — not a constructor argument, not a setter, not a
/// constant — so whoever held the owner key chose where the protocol's
/// earnings went at the moment of withdrawal, and nothing recorded the choice
/// in advance or made it visible afterwards except the transfer itself.
///
/// That is the most obvious question an auditor asks, and "we type it each
/// time" is not an answer. It is also a product question rather than an
/// operational one: "a 2% rake" and "a 2% rake to an address the owner picks
/// later" describe different things, and only one of them can be stated in a
/// terms panel.
///
/// # Why settable rather than immutable
///
/// An `immutable` treasury is the stronger guarantee and it was the other real
/// option. It loses on one point: a treasury address is exactly the kind of
/// thing that has to change — a multisig gets rotated, a signer is lost, an
/// organisation moves — and with `immutable` the only way to change it is to
/// redeploy every contract that holds one. GHO-51 and GHO-52 spent two issues
/// establishing what a redeploy actually costs here, and choosing a design
/// whose maintenance operation is "redeploy the protocol" contradicts that
/// work.
///
/// The authority given up is small and bounded. `setTreasury` cannot move a
/// token; it changes where a *later* owner-only withdrawal may send funds that
/// the owner could already have sent anywhere. An owner who wanted the money
/// elsewhere did not need this function — it is strictly a narrowing of what
/// the withdrawal calls accept, not a widening of what the owner can do.
///
/// # Why the default is the owner
///
/// The constructor takes no treasury argument and initialises it to
/// `initialOwner`. That is deliberate, and it is about migration cost rather
/// than aesthetics: adding a constructor parameter changes the signature of
/// every deployment script, every test helper and the frontend's expectations
/// of the deploy. Every unchanged constructor argument is one less thing for a
/// redeploy to get wrong, and Part 7.46 is a record of what getting one wrong
/// costs.
///
/// Defaulting to the owner is also the honest default. Before this contract
/// existed, the owner was already the only address that could decide where the
/// money went; starting there changes nothing about who is trusted and makes
/// the first `TreasurySet` event the moment somebody deliberately chose
/// otherwise.
abstract contract Treasured is Ownable {
    /// @notice Where withdrawn fees and reserves are sent. Never zero: it
    /// starts as the initial owner and `setTreasury` refuses the zero address.
    address public treasury;

    /// @param from The previous destination. Zero only for the initial event
    /// emitted at construction.
    event TreasurySet(address indexed from, address indexed to);

    error ZeroTreasury();

    constructor() {
        treasury = owner();
        emit TreasurySet(address(0), owner());
    }

    /// @notice Point protocol earnings at a different address.
    ///
    /// @dev Emitted rather than merely stored, so that a change of destination
    /// is something an indexer and an observer can see happen. A treasury that
    /// could be repointed silently would be no better than the `to` parameter
    /// this replaced — the point is not that the owner is constrained, it is
    /// that the choice is on the record before the money moves rather than
    /// inside the transaction that moves it.
    ///
    /// No zero address. Renouncing a treasury has no meaning — there is no
    /// "nobody" to pay, and a zero destination would simply make every
    /// withdrawal burn the protocol's earnings.
    function setTreasury(address to) external onlyOwner {
        if (to == address(0)) revert ZeroTreasury();
        emit TreasurySet(treasury, to);
        treasury = to;
    }
}
