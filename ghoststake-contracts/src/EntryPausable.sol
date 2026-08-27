// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice An emergency stop that can only ever stop people *arriving*.
///
/// # Why this exists rather than OpenZeppelin's `Pausable`
///
/// `Pausable` is deliberately general: `whenNotPaused` says nothing about what
/// it is guarding, so the guarantee lives in a convention that the next person
/// to add a modifier has to already know about. The whole value of an
/// emergency stop in a lending protocol is the half it *cannot* reach, and a
/// guarantee that depends on everybody remembering is not one.
///
/// So the name carries it. A contract that inherits `EntryPausable` and a
/// modifier called `whenEntriesOpen` make `whenEntriesOpen` on a withdrawal
/// read wrong at the point somebody writes it, which is the only place it can
/// usefully read wrong.
///
/// The rule, in full:
///
/// - **Pausable:** depositing, supplying, borrowing, opening a round, taking a
///   position. Everything that puts new value or new risk into the system.
/// - **Never pausable:** withdrawing, repaying, claiming, liquidating, writing
///   off bad debt, settling a round that is already open, and any accrual the
///   above depend on.
///
/// A protocol that can stop you leaving is a different product from one that
/// can stop you arriving, and only the second is defensible. Pausing
/// liquidation would be worse than useless besides — it lets underwater
/// positions sit and rot, turning a temporary problem into the permanent one
/// GHO-45 had to build a whole mechanism for.
///
/// # Why a guardian and not the owner
///
/// `CollateralVault` has no owner, and that is a property worth keeping: today
/// there is no address anywhere that can touch a staked position. Making it
/// `Ownable` to gain a pause would trade that away for far more authority than
/// the pause needs.
///
/// The guardian is the narrowest role that does the job. It cannot move a
/// token, cannot change a parameter, cannot stop anyone exiting, and cannot
/// take anything. The worst a compromised guardian key achieves is that new
/// deposits are refused until it is rotated — which is recoverable, unlike
/// every other kind of admin key.
///
/// It is also a *hot* role by design. Pausing is the thing you need to do at
/// four in the morning from a laptop, which is exactly the key you do not want
/// holding anything else.
abstract contract EntryPausable {
    /// @notice Whether new value is currently refused. Exits are unaffected in
    /// either state; see the contract note.
    bool public entriesPaused;

    /// @notice The only address that may pause. Zero means nobody can — see
    /// `transferPauseGuardian`.
    address public pauseGuardian;

    event EntriesPaused(address indexed by);
    event EntriesUnpaused(address indexed by);
    event PauseGuardianTransferred(address indexed from, address indexed to);

    error EntriesArePaused();
    error NotPauseGuardian(address caller);
    error CannotRenounceWhilePaused();

    /// @dev Guards an entry point. Never put this on an exit.
    modifier whenEntriesOpen() {
        if (entriesPaused) revert EntriesArePaused();
        _;
    }

    modifier onlyPauseGuardian() {
        if (msg.sender != pauseGuardian) revert NotPauseGuardian(msg.sender);
        _;
    }

    /// @param guardian The initial guardian. The zero address deploys a
    /// contract that can never be paused, which is a legitimate choice and the
    /// only one that is irreversible.
    constructor(address guardian) {
        pauseGuardian = guardian;
        emit PauseGuardianTransferred(address(0), guardian);
    }

    function pauseEntries() external onlyPauseGuardian {
        entriesPaused = true;
        emit EntriesPaused(msg.sender);
    }

    /// @dev Unpausing is the same role as pausing, deliberately.
    ///
    /// Splitting them — a hot key that halts, a cold key that resumes — is
    /// what Aave does, and it is the right shape when there is a cold key to
    /// split to. Here there is not: the vault has no owner, so an
    /// owner-gated unpause would have to invent one, which is the authority
    /// this whole design is avoiding. The alternative, a guardian that can
    /// pause but never unpause, is a one-way switch that halts new deposits
    /// permanently the first time anyone is wrong about an incident.
    function unpauseEntries() external onlyPauseGuardian {
        entriesPaused = false;
        emit EntriesUnpaused(msg.sender);
    }

    /// @notice Hand the role on, or give it up for good by passing zero.
    ///
    /// @dev Renouncing is refused while paused, and that is the whole reason
    /// the check exists: handing the role to nobody mid-pause would leave
    /// entries refused forever with no address in existence that could lift
    /// it. Every other use of zero here is a deliberate, defensible act — a
    /// protocol declaring it can no longer be halted.
    function transferPauseGuardian(address to) external onlyPauseGuardian {
        if (to == address(0) && entriesPaused) revert CannotRenounceWhilePaused();
        emit PauseGuardianTransferred(pauseGuardian, to);
        pauseGuardian = to;
    }
}
