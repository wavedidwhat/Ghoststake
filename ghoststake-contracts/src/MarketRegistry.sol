// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ParimutuelRound } from "./ParimutuelRound.sol";
import { BorrowToPositionRouter } from "./BorrowToPositionRouter.sol";

/// @notice The list of markets this deployment offers.
///
/// # Why a contract and not an environment variable
///
/// Until now the frontend learned about its market from
/// `NEXT_PUBLIC_MARKET_ADDRESS`, baked into the image at build time. Adding a
/// market therefore meant a rebuild and a redeploy of the app, which is an
/// absurd amount of ceremony for what is conceptually one row. Worse, it puts
/// the list somewhere the chain cannot check: an address typo ships a market
/// that reads as a contract with no code, and every pool renders as a
/// plausible zero.
///
/// A registry makes adding a market a transaction, and lets the chain refuse
/// a listing that could not work.
///
/// # What is stored, and what is deliberately not
///
/// Stored: the market, its router, the nominal round length, and whether it
/// is listed. Those are facts nothing else knows.
///
/// **Not** stored: the feed address, the asset label, the price scale. All of
/// those are already discoverable — `market.oracle()` gives the adapter,
/// `oracle.feed()` gives the aggregator, and `feed.description()` names the
/// pair. A copy here could disagree with the contract it describes, and the
/// copy is the one a UI would show. GHO-29 already settled this argument for
/// the demo-market badge: read what the chain says, do not restate it.
///
/// `horizon` is the exception that proves the rule. A market does not fix a
/// round length — the operator chooses one per round — so it is a *stated
/// intent* rather than a derivable fact, and there is nowhere else to put it.
/// It is advisory, and named so that nothing is tempted to enforce it.
///
/// # What listing does not mean
///
/// Nothing here is a claim about safety, and nothing here can move funds.
/// The registry holds no assets, is never called by the market or the router,
/// and delisting a market does not pause it: rounds already open still lock,
/// settle and pay out, exactly as if this contract did not exist. It is a
/// directory, and the only thing it can break is a UI's idea of what to show.
contract MarketRegistry is Ownable {
    struct Listing {
        ParimutuelRound market;
        BorrowToPositionRouter router;
        /// @dev The round length this market is meant to be run at, in
        /// seconds. Advisory: nothing enforces it, and a round of any length
        /// can be opened.
        uint64 horizon;
        /// @dev Delisting hides a market from the list. It does not stop it.
        bool enabled;
    }

    Listing[] private _listings;

    /// @dev Market address to its index plus one, so zero means "not listed".
    mapping(address => uint256) private _indexPlusOne;

    event MarketListed(uint256 indexed id, address indexed market, address router, uint64 horizon);
    event MarketEnabledSet(uint256 indexed id, bool enabled);
    event MarketHorizonSet(uint256 indexed id, uint64 horizon);

    error ZeroAddress();
    error AlreadyListed(address market);
    error UnknownListing(uint256 id);
    error RouterServesAnotherMarket(address router, address itsMarket);
    error RouterNotWhitelisted(address market, address router);
    error ZeroHorizon();

    constructor(address initialOwner) Ownable(initialOwner) { }

    // ------------------------------------------------------------------
    // Writes
    // ------------------------------------------------------------------

    /// @notice List a market, after checking that it is one.
    ///
    /// @dev The three checks are the reason this is worth deploying rather
    /// than keeping a list in a config file. Each one is a mistake that
    /// otherwise surfaces as a user's transaction reverting:
    ///
    /// 1. **The router serves this market.** `BorrowToPositionRouter` binds
    ///    its market as a constructor immutable, so a router paired with the
    ///    wrong market would route a borrow into a different one.
    /// 2. **The market whitelists the router.** `takePositionFor` reverts
    ///    with `NotRouter` otherwise, so the borrow-to-position button would
    ///    fail for everyone, every time.
    /// 3. **The market is not already listed.** Two rows for one market is
    ///    two cards for one set of pools.
    ///
    /// What is *not* checked is that the market and router share the vault's
    /// asset. The registry does not know which vault it is meant to be part
    /// of, and inventing that link here would be worse than not checking:
    /// see `deployMarket` in the deploy script, where the pairing is made.
    function list(ParimutuelRound market, BorrowToPositionRouter router, uint64 horizon)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (address(market) == address(0) || address(router) == address(0)) revert ZeroAddress();
        if (horizon == 0) revert ZeroHorizon();
        if (_indexPlusOne[address(market)] != 0) revert AlreadyListed(address(market));

        address itsMarket = address(router.market());
        if (itsMarket != address(market)) revert RouterServesAnotherMarket(address(router), itsMarket);
        if (!market.isRouter(address(router))) revert RouterNotWhitelisted(address(market), address(router));

        id = _listings.length;
        _listings.push(Listing({ market: market, router: router, horizon: horizon, enabled: true }));
        _indexPlusOne[address(market)] = id + 1;

        emit MarketListed(id, address(market), address(router), horizon);
    }

    /// @notice Show or hide a market in the list.
    ///
    /// @dev Not a pause, and cannot be mistaken for one from inside the
    /// protocol: the market never reads this contract. A delisted market's
    /// open rounds still lock, settle and pay out. Hiding one whose rounds
    /// are still live hides them from the people holding positions in them,
    /// which is why this is worth saying twice.
    function setEnabled(uint256 id, bool enabled) external onlyOwner {
        if (id >= _listings.length) revert UnknownListing(id);
        _listings[id].enabled = enabled;
        emit MarketEnabledSet(id, enabled);
    }

    /// @notice Restate the round length a market is meant to be run at.
    function setHorizon(uint256 id, uint64 horizon) external onlyOwner {
        if (id >= _listings.length) revert UnknownListing(id);
        if (horizon == 0) revert ZeroHorizon();
        _listings[id].horizon = horizon;
        emit MarketHorizonSet(id, horizon);
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    function count() external view returns (uint256) {
        return _listings.length;
    }

    function at(uint256 id) external view returns (Listing memory) {
        if (id >= _listings.length) revert UnknownListing(id);
        return _listings[id];
    }

    /// @notice Every listing, enabled or not, in the order they were added.
    ///
    /// @dev One call, because the alternative is `count()` followed by a
    /// request per market and a UI that renders them as they trickle in.
    /// Unbounded in principle; in practice a list a human browses is tens of
    /// rows, and a registry that outgrows one `eth_call` has a bigger problem
    /// than pagination.
    ///
    /// Disabled rows are returned rather than filtered. A caller holding a
    /// position in a delisted market still has to be able to find it, and a
    /// read that silently omits rows makes that impossible.
    function all() external view returns (Listing[] memory) {
        return _listings;
    }

    /// @notice Whether this market is listed, and where.
    /// @return listed Whether the market appears in the registry at all.
    /// @return id Its index, meaningless when `listed` is false.
    function find(address market) external view returns (bool listed, uint256 id) {
        uint256 stored = _indexPlusOne[market];
        return stored == 0 ? (false, 0) : (true, stored - 1);
    }
}
