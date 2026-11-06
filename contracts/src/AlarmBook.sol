// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAlarmBook} from "./interfaces/IAlarmBook.sol";
import {SignatureChecker} from "./lib/SignatureChecker.sol";
import {CappedCall} from "./lib/CappedCall.sol";

/// @title AlarmBook
/// @notice Permissionless registry of danger detectors. Anyone can register a detector, anyone can `poke`
/// it, and it fires when its on-chain condition holds. Users choose which detector keys to arm per
/// position in ExitRouter; a live alarm lets ANY keeper exit those positions back to their owners.
/// Kinds:
///   PRICE_BELOW     Chainlink feed answer below `threshold` and fresher than `window` s.
///   SHARE_DROP      ERC-4626 share price fell more than `threshold` bps under its high-water mark.
///   PAUSED          target's bool view (`a` = selector, default paused()) returns true.
///   ADDRESS_CHANGE  target's address view (`a` = selector) differs from the registered value.
///   DRAIN           ERC-4626 totalAssets fell more than `threshold` bps under the low of the previous sampling
///                   period, seen by two pokes at least DRAIN_CONFIRM s apart. `window` is at least MIN_DRAIN_WINDOW.
///   QUORUM          k = `threshold` distinct active watchers signed an attestation.
///   BOTH            keys `a` and `b` both fired within `window` s of now.
/// An alarm can never move funds; it only widens who may call ExitRouter.exit, which pays the owner only.
///
/// Reads of a detector's target are capped at TARGET_READ_GAS and always get the whole cap (a call with less gas left
/// reverts NotEnoughGas), so what a read returns depends on the target, never on the caller's gas. A read that fails
/// means "not tripped" for firing and "not clear" for `armable`.
contract AlarmBook is IAlarmBook {
    enum Kind {
        PRICE_BELOW,
        SHARE_DROP,
        PAUSED,
        ADDRESS_CHANGE,
        DRAIN,
        QUORUM,
        BOTH
    }

    /// @dev What a detector's condition reads as right now. UNKNOWN: the target could not be read.
    enum Reading {
        CLEAR,
        TRIPPED,
        UNKNOWN
    }

    struct Detector {
        Kind kind;
        address target;
        uint256 threshold;
        uint32 window;
        bytes32 a;
        bytes32 b;
    }

    struct State {
        bool exists;
        uint64 firedAt;
        uint64 snapAt;
        uint256 baseline; // SHARE_DROP: high-water share price; ADDRESS_CHANGE: registered address; DRAIN: lowest sample since snapAt
        uint256 snap; // DRAIN: the lowest sample of the previous period, which alarms measure against
        uint64 episodeAt; // when the current run of fires began (0 = none, or ended by rebase)
        uint64 pendingAt; // DRAIN: when a poke first saw the drop it is waiting to confirm (0 = none)
    }

    /// @notice EIP-712 type hash of a watcher attestation.
    bytes32 public constant ATTEST_TYPEHASH = keccak256("Attest(bytes32 key,bytes32 evidence,uint64 deadline)");
    /// @notice A key cannot fire again until this long after its last fire.
    uint256 public constant REFIRE_AFTER = 1 days;
    /// @notice A tripped key can be rebased once its current episode is at least this old.
    uint256 public constant REBASE_AFTER = 7 days;
    /// @notice Largest k a QUORUM detector may require.
    uint256 public constant MAX_QUORUM = 32;
    /// @notice Furthest a signature deadline may be from the firing block (shorter than REFIRE_AFTER, so it can't fire twice).
    uint256 public constant MAX_ATTEST_LIFE = 1 hours;
    /// @notice Shortest DRAIN window (its sampling period is window / 2).
    uint32 public constant MIN_DRAIN_WINDOW = 1200;
    /// @notice A DRAIN fire needs a second tripped poke at least this long after the first.
    uint256 public constant DRAIN_CONFIRM = 60;
    /// @notice Gas given to every read of a detector's target.
    uint256 public constant TARGET_READ_GAS = 1_000_000;
    /// @notice A newly approved watcher can sign only after this delay.
    uint256 public constant WATCHER_DELAY = 2 days;
    /// @notice Longest watcher approval, counted from the approving call.
    uint256 public constant MAX_WATCHER_TERM = 365 days;

    /// @dev Gas kept on top of the cap so the call itself can be paid for: cold access, memory and the 1/64 rule.
    uint256 internal constant READ_GAS_OVERHEAD = TARGET_READ_GAS / 63 + 10_000;
    /// @dev Largest share price or totalAssets reading used, so `value * 10_000` can't overflow.
    uint256 internal constant MAX_READING = type(uint256).max / 10_000;

    /// @notice The only account that can change the watcher list (the Timelock). It never expires.
    address public immutable ADMIN;
    /// @notice EIP-712 domain separator ("Canopy AlarmBook", version "2", this chain, this contract).
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @notice When each watcher's approval starts (0 = not approved).
    mapping(address => uint64) public watcherSince;
    /// @notice When each watcher's approval ends (exclusive; 0 = not approved).
    mapping(address => uint64) public watcherUntil;
    mapping(bytes32 => Detector) internal _detectors;
    /// @notice Per-key firing and baseline state.
    mapping(bytes32 => State) public state;
    mapping(bytes32 => address[]) internal _signers;

    /// @notice A detector was registered.
    /// @param key Its key.
    /// @param kind Its kind.
    /// @param target What it reads.
    /// @param threshold Its threshold (bps for SHARE_DROP and DRAIN, a price for PRICE_BELOW, k for QUORUM).
    /// @param window Its window in seconds (PRICE_BELOW staleness, DRAIN period x2, BOTH span).
    /// @param a Selector (PAUSED, ADDRESS_CHANGE) or first part (BOTH).
    /// @param b Second part (BOTH).
    event Registered(bytes32 indexed key, Kind kind, address indexed target, uint256 threshold, uint32 window, bytes32 a, bytes32 b);
    /// @notice A key fired.
    /// @param key The key.
    /// @param kind Its kind.
    /// @param target Its target.
    /// @param by Who sent the transaction.
    /// @param evidence The attested hash for QUORUM, zero otherwise.
    event Fired(bytes32 indexed key, Kind kind, address indexed target, address by, bytes32 evidence);
    /// @notice A baseline rolled forward.
    /// @param key The key.
    /// @param value The new SHARE_DROP mark, or the new DRAIN reference.
    event Checkpoint(bytes32 indexed key, uint256 value);
    /// @notice A DRAIN poke saw the drop for the first time; a poke at least DRAIN_CONFIRM s later can fire it.
    /// @param key The key.
    /// @param at When the drop was first seen.
    event Pending(bytes32 indexed key, uint64 at);
    /// @notice A key that had been tripped for at least REBASE_AFTER took the current reading as its new baseline.
    /// @param key The key.
    /// @param newBaseline The new mark, address (as a number) or DRAIN candidate.
    event Rebased(bytes32 indexed key, uint256 newBaseline);
    /// @notice A watcher's approval changed.
    /// @param watcher The watcher.
    /// @param since When the approval starts (0 when removed).
    /// @param until When it ends, exclusive (0 when removed).
    event WatcherSet(address indexed watcher, uint64 since, uint64 until);

    /// @notice The caller is not ADMIN.
    error NotAdmin();
    /// @notice No detector is registered under this key.
    error Unknown();
    /// @notice The detector can never work as given.
    error BadDetector();
    /// @notice fireByQuorum was called for a key that is not a QUORUM detector.
    error NotQuorumKind();
    /// @notice The attestation deadline has passed.
    error Expired();
    /// @notice The attestation deadline is more than MAX_ATTEST_LIFE away.
    error DeadlineTooFar();
    /// @notice The key fired less than REFIRE_AFTER ago.
    error AlreadyLive();
    /// @notice Too few signers, mismatched lengths, or signers not strictly ascending.
    error BadSigners();
    /// @param who The signer that is not an active watcher.
    /// @notice A signer is not an active watcher.
    error NotWatcher(address who);
    /// @param who The signer whose signature does not check out.
    /// @notice A signature is invalid for its signer.
    error BadSignature(address who);
    /// @notice The approval end is zero-but-not-removal, in the past, beyond MAX_WATCHER_TERM, or not after its start.
    error BadWatcherTerm();
    /// @notice Less gas is left than a target read needs, so the read would not get its full TARGET_READ_GAS.
    error NotEnoughGas();
    /// @notice rebase is only for SHARE_DROP, ADDRESS_CHANGE and DRAIN; the other kinds clear on their own.
    error NotRebasable();
    /// @notice The key is not tripped now (or its target can't be read), so there is nothing to rebase.
    error NotTripped();
    /// @notice The key has no current episode, or its episode began less than REBASE_AFTER ago.
    error EpisodeTooShort();

    /// @param admin The account that manages the watcher list (the Timelock).
    /// @param initialWatchers Watchers active from deployment until deployment + MAX_WATCHER_TERM.
    constructor(address admin, address[] memory initialWatchers) {
        ADMIN = admin;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Canopy AlarmBook"),
                keccak256("2"),
                block.chainid,
                address(this)
            )
        );
        uint64 since = uint64(block.timestamp);
        uint64 until = uint64(block.timestamp + MAX_WATCHER_TERM);
        for (uint256 i; i < initialWatchers.length; ++i) {
            watcherSince[initialWatchers[i]] = since;
            watcherUntil[initialWatchers[i]] = until;
            emit WatcherSet(initialWatchers[i], since, until);
        }
    }

    // ------------------------------------------------------------------ watchers

    /// @notice Approve, extend or remove a watcher. Only ADMIN. A watcher that is not active now starts WATCHER_DELAY
    /// after this call; an active watcher's new end applies at once. `until == 0` removes the watcher at once.
    /// @param w The watcher.
    /// @param until When the approval ends (exclusive), at most MAX_WATCHER_TERM from now; 0 removes.
    function setWatcher(address w, uint64 until) external {
        if (msg.sender != ADMIN) revert NotAdmin();
        if (until == 0) {
            delete watcherSince[w];
            delete watcherUntil[w];
            emit WatcherSet(w, 0, 0);
            return;
        }
        if (until <= block.timestamp || until > block.timestamp + MAX_WATCHER_TERM) revert BadWatcherTerm();
        uint64 since = isWatcher(w) ? watcherSince[w] : uint64(block.timestamp + WATCHER_DELAY);
        if (until <= since) revert BadWatcherTerm();
        watcherSince[w] = since;
        watcherUntil[w] = until;
        emit WatcherSet(w, since, until);
    }

    /// @notice Whether `w` is an active watcher right now.
    /// @param w The account to check.
    /// @return True if its approval has started and not yet ended.
    function isWatcher(address w) public view returns (bool) {
        uint64 since = watcherSince[w];
        return since != 0 && since <= block.timestamp && block.timestamp < watcherUntil[w];
    }

    // ------------------------------------------------------------------ registry

    /// @notice The key a detector is stored under.
    /// @param d The detector.
    /// @return The keccak256 of its ABI-encoded fields.
    function keyOf(Detector memory d) public pure returns (bytes32) {
        return keccak256(abi.encode(d.kind, d.target, d.threshold, d.window, d.a, d.b));
    }

    /// @notice Register a detector. Open to anyone, and idempotent: an existing key is returned unchanged.
    /// @param d The detector.
    /// @return key Its key.
    function register(Detector calldata d) external returns (bytes32 key) {
        key = keyOf(d);
        State storage s = state[key];
        if (s.exists) return key;
        _validate(d);
        s.exists = true;
        _detectors[key] = d;
        if (d.kind == Kind.SHARE_DROP) {
            (bool ok, uint256 px) = _sharePrice(d.target);
            if (!ok || px == 0) revert BadDetector();
            s.baseline = px;
        } else if (d.kind == Kind.ADDRESS_CHANGE) {
            (bool ok, uint256 v) = _readAddress(d.target, _sel(d.a, bytes4(0)));
            if (!ok) revert BadDetector();
            s.baseline = v;
        } else if (d.kind == Kind.DRAIN) {
            (bool ok, uint256 ta) = _totalAssets(d.target);
            if (!ok || ta == 0) revert BadDetector();
            s.baseline = ta; // A candidate only. Nothing can fire until a later period has confirmed it.
            s.snapAt = uint64(block.timestamp);
        }
        emit Registered(key, d.kind, d.target, d.threshold, d.window, d.a, d.b);
    }

    /// @notice A registered detector (all zero for an unknown key).
    /// @param key The key.
    /// @return The detector.
    function detector(bytes32 key) external view returns (Detector memory) {
        return _detectors[key];
    }

    /// @notice The watchers who signed a QUORUM key's last fire.
    /// @param key The key.
    /// @return The signers, ascending.
    function signersOf(bytes32 key) external view returns (address[] memory) {
        return _signers[key];
    }

    // ------------------------------------------------------------------ firing

    /// @notice View for keepers: would `poke(key)` make progress now, that is fire, or start a DRAIN confirmation?
    /// It is false while a DRAIN confirmation is pending and not yet DRAIN_CONFIRM old.
    /// @param key The key.
    /// @return True if a poke now would fire or start a confirmation.
    function check(bytes32 key) public view returns (bool) {
        State storage s = state[key];
        if (!s.exists || _liveNow(s)) return false;
        Detector memory d = _detectors[key];
        (Reading r,) = _reading(d, s);
        if (r != Reading.TRIPPED) return false;
        if (d.kind != Kind.DRAIN || !_pendingLive(s, d)) return true;
        return block.timestamp >= uint256(s.pendingAt) + DRAIN_CONFIRM;
    }

    /// @notice Whether ExitRouter may arm this key now: it exists, its target reads clear (a failed read is not clear),
    /// and it has not fired within the last REFIRE_AFTER.
    /// @param key The key.
    /// @return True if the key can be armed.
    function armable(bytes32 key) external view returns (bool) {
        State storage s = state[key];
        if (!s.exists || _liveNow(s)) return false;
        (Reading r,) = _reading(_detectors[key], s);
        return r == Reading.CLEAR;
    }

    /// @notice Fire `key` if its condition holds and it is not live. For DRAIN the first tripped poke only records
    /// `pendingAt`, and a later tripped one at least DRAIN_CONFIRM s after it (and within `window`) fires. A poke that
    /// reads the vault clear or can't read it leaves the sighting alone, so a flash deposit can't cancel it; a sighting
    /// lapses only once it is older than `window`. Never reverts on a condition that does not hold.
    /// @param key The key.
    /// @return fired True if this call fired the key.
    function poke(bytes32 key) external returns (bool fired) {
        State storage s = state[key];
        if (!s.exists) revert Unknown();
        if (_liveNow(s)) return false;
        Detector memory d = _detectors[key];
        (Reading r,) = _reading(d, s);
        if (d.kind == Kind.DRAIN) {
            if (r != Reading.TRIPPED) return false; // clear or unreadable: the sighting stays until it lapses
            if (!_pendingLive(s, d)) {
                s.pendingAt = uint64(block.timestamp);
                emit Pending(key, uint64(block.timestamp));
                return false;
            }
            if (block.timestamp < uint256(s.pendingAt) + DRAIN_CONFIRM) return false;
            s.pendingAt = 0;
        } else if (r != Reading.TRIPPED) {
            return false;
        }
        _fire(key, s, d, bytes32(0));
        return true;
    }

    /// @notice Rolls baselines forward, and only while the key reads clear. The SHARE_DROP high-water mark only rises.
    /// DRAIN never trusts one reading, because anyone can call this inside a flash deposit. Calls sample totalAssets, and
    /// every window/2 the lowest sample of the period becomes the reference. So an inflated reading only counts if it
    /// survives a whole period of samples, and a keeper sampling once a period is enough. Nothing rolls while the
    /// detector is tripped or unreadable, so a drain cannot be "reset" away.
    /// @param key The key.
    function checkpoint(bytes32 key) external {
        State storage s = state[key];
        if (!s.exists) revert Unknown();
        Detector memory d = _detectors[key];
        if (d.kind != Kind.SHARE_DROP && d.kind != Kind.DRAIN) return;
        (Reading r, uint256 v) = _reading(d, s);
        if (r != Reading.CLEAR) return;
        if (d.kind == Kind.SHARE_DROP) {
            if (v > s.baseline) {
                s.baseline = v;
                emit Checkpoint(key, v);
            }
            return;
        }
        if (v == 0) return;
        if (block.timestamp < uint256(s.snapAt) + d.window / 2) {
            if (v < s.baseline) s.baseline = v;
            return;
        }
        s.snap = s.baseline;
        s.baseline = v;
        s.snapAt = uint64(block.timestamp);
        emit Checkpoint(key, s.snap);
    }

    /// @notice Reset a key that has been tripped for a long time, so it stops refiring on an old event. Allowed when the
    /// key reads tripped now and its current episode began at least REBASE_AFTER ago. SHARE_DROP takes the current share
    /// price as its mark, ADDRESS_CHANGE the current address, and DRAIN restarts sampling as at register. Ends the
    /// episode. Open to anyone. PRICE_BELOW, PAUSED, QUORUM and BOTH clear on their own and can't be rebased.
    /// @param key The key.
    function rebase(bytes32 key) external {
        State storage s = state[key];
        if (!s.exists) revert Unknown();
        Detector memory d = _detectors[key];
        if (d.kind != Kind.SHARE_DROP && d.kind != Kind.ADDRESS_CHANGE && d.kind != Kind.DRAIN) revert NotRebasable();
        if (!_episodeCurrent(s) || block.timestamp < uint256(s.episodeAt) + REBASE_AFTER) revert EpisodeTooShort();
        (Reading r, uint256 v) = _reading(d, s);
        if (r != Reading.TRIPPED) revert NotTripped();
        s.baseline = v;
        if (d.kind == Kind.DRAIN) {
            s.snap = 0;
            s.snapAt = uint64(block.timestamp);
            s.pendingAt = 0;
        }
        s.episodeAt = 0;
        emit Rebased(key, v);
    }

    /// @notice The EIP-712 digest watchers sign for a QUORUM attestation.
    /// @param key The QUORUM key.
    /// @param evidence A hash of the report the watchers checked.
    /// @param deadline The last second the attestation can fire.
    /// @return The digest.
    function attestDigest(bytes32 key, bytes32 evidence, uint64 deadline) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(ATTEST_TYPEHASH, key, evidence, deadline)))
        );
    }

    /// @notice Fire a QUORUM alarm with k distinct active watcher signatures (signers sorted ascending).
    /// @param key The QUORUM key.
    /// @param evidence The attested evidence hash.
    /// @param deadline The signed deadline: not passed, and at most MAX_ATTEST_LIFE ahead.
    /// @param signers The watchers, strictly ascending.
    /// @param sigs Their signatures (65-byte ECDSA, low s, or anything an ERC-1271 watcher accepts).
    function fireByQuorum(bytes32 key, bytes32 evidence, uint64 deadline, address[] calldata signers, bytes[] calldata sigs)
        external
    {
        State storage s = state[key];
        if (!s.exists) revert Unknown();
        Detector memory d = _detectors[key];
        if (d.kind != Kind.QUORUM) revert NotQuorumKind();
        if (block.timestamp > deadline) revert Expired();
        if (deadline > block.timestamp + MAX_ATTEST_LIFE) revert DeadlineTooFar();
        if (_liveNow(s)) revert AlreadyLive();
        if (signers.length < d.threshold || signers.length != sigs.length) revert BadSigners();

        bytes32 digest = attestDigest(key, evidence, deadline);
        address prev;
        for (uint256 i; i < signers.length; ++i) {
            address w = signers[i];
            if (w <= prev) revert BadSigners();
            prev = w;
            if (!isWatcher(w)) revert NotWatcher(w);
            if (!SignatureChecker.isValidSignatureNow(w, digest, sigs[i])) revert BadSignature(w);
        }
        _signers[key] = signers;
        _fire(key, s, d, evidence);
    }

    /// @notice Whether `key` fired no more than `ttl` seconds ago (ttl 0: in this very second).
    /// @param key The key.
    /// @param ttl How far back a fire still counts.
    /// @return True if it fired within `ttl`.
    function isLive(bytes32 key, uint256 ttl) external view returns (bool) {
        State storage s = state[key];
        return s.firedAt != 0 && block.timestamp <= uint256(s.firedAt) + ttl;
    }

    // ------------------------------------------------------------------ internals

    function _fire(bytes32 key, State storage s, Detector memory d, bytes32 evidence) internal {
        if (!_episodeCurrent(s)) s.episodeAt = uint64(block.timestamp);
        s.firedAt = uint64(block.timestamp);
        emit Fired(key, d.kind, d.target, msg.sender, evidence);
    }

    /// @dev An episode is the run of fires that each came within 2 * REFIRE_AFTER of the one before.
    function _episodeCurrent(State storage s) internal view returns (bool) {
        return s.episodeAt != 0 && block.timestamp <= uint256(s.firedAt) + 2 * REFIRE_AFTER;
    }

    function _liveNow(State storage s) internal view returns (bool) {
        return s.firedAt != 0 && block.timestamp < uint256(s.firedAt) + REFIRE_AFTER;
    }

    /// @dev A DRAIN confirmation counts only within the detector's window; an older one starts over.
    function _pendingLive(State storage s, Detector memory d) internal view returns (bool) {
        return s.pendingAt != 0 && block.timestamp <= uint256(s.pendingAt) + d.window;
    }

    function _validate(Detector calldata d) internal view {
        Kind k = d.kind;
        if (k == Kind.PRICE_BELOW) {
            if (d.threshold == 0 || d.window == 0 || d.target.code.length == 0) revert BadDetector();
        } else if (k == Kind.SHARE_DROP || k == Kind.DRAIN) {
            if (d.threshold == 0 || d.threshold >= 10_000 || d.target.code.length == 0) revert BadDetector();
            if (k == Kind.DRAIN && d.window < MIN_DRAIN_WINDOW) revert BadDetector();
        } else if (k == Kind.PAUSED || k == Kind.ADDRESS_CHANGE) {
            if (d.target.code.length == 0) revert BadDetector();
        } else if (k == Kind.QUORUM) {
            if (d.threshold < 2 || d.threshold > MAX_QUORUM) revert BadDetector();
        } else if (k == Kind.BOTH) {
            // A part can't refire for REFIRE_AFTER, so any shorter window could close on a part that can't refresh.
            if (!state[d.a].exists || !state[d.b].exists || d.a == d.b || d.window < REFIRE_AFTER) revert BadDetector();
        }
    }

    /// @dev The detector's condition now, with the value read (SHARE_DROP price, ADDRESS_CHANGE address, DRAIN totalAssets).
    function _reading(Detector memory d, State storage s) internal view returns (Reading, uint256) {
        Kind k = d.kind;
        if (k == Kind.PRICE_BELOW) {
            (bool ok,, uint256[5] memory w) = _targetRead(d.target, abi.encodeWithSelector(0xfeaf968c), 5); // latestRoundData()
            if (!ok) return (Reading.UNKNOWN, 0);
            int256 ans = int256(w[1]);
            uint256 upd = w[3];
            if (ans <= 0 || upd == 0 || upd > block.timestamp || block.timestamp - upd > d.window) return (Reading.UNKNOWN, 0);
            return (uint256(ans) < d.threshold ? Reading.TRIPPED : Reading.CLEAR, uint256(ans));
        }
        if (k == Kind.SHARE_DROP) {
            (bool ok, uint256 px) = _sharePrice(d.target);
            if (!ok) return (Reading.UNKNOWN, 0);
            return (px * 10_000 < s.baseline * (10_000 - d.threshold) ? Reading.TRIPPED : Reading.CLEAR, px);
        }
        if (k == Kind.PAUSED) {
            (bool ok, bool exhausted, uint256[5] memory w) =
                _targetRead(d.target, abi.encodeWithSelector(_sel(d.a, bytes4(keccak256("paused()")))), 1);
            // A target that answers with anything but 1, or has no such view and reverts, is not paused. One that ran
            // out of its full gas cap can't be told apart from a paused one, so it reads UNKNOWN.
            if (exhausted) return (Reading.UNKNOWN, 0);
            return (ok && w[0] == 1 ? Reading.TRIPPED : Reading.CLEAR, ok ? w[0] : 0);
        }
        if (k == Kind.ADDRESS_CHANGE) {
            (bool ok, uint256 v) = _readAddress(d.target, _sel(d.a, bytes4(0)));
            if (!ok) return (Reading.UNKNOWN, 0);
            return (v != s.baseline ? Reading.TRIPPED : Reading.CLEAR, v);
        }
        if (k == Kind.DRAIN) {
            (bool ok, uint256 ta) = _totalAssets(d.target);
            if (!ok) return (Reading.UNKNOWN, 0);
            if (s.snap == 0 || block.timestamp - s.snapAt > d.window) return (Reading.CLEAR, ta); // no live reference
            return (ta * 10_000 < s.snap * (10_000 - d.threshold) ? Reading.TRIPPED : Reading.CLEAR, ta);
        }
        if (k == Kind.BOTH) {
            bool both = _firedWithin(state[d.a], d.window) && _firedWithin(state[d.b], d.window);
            return (both ? Reading.TRIPPED : Reading.CLEAR, 0);
        }
        return (Reading.CLEAR, 0); // QUORUM fires only through fireByQuorum
    }

    function _firedWithin(State storage s, uint256 window) internal view returns (bool) {
        return s.firedAt != 0 && block.timestamp <= uint256(s.firedAt) + window;
    }

    function _sel(bytes32 a, bytes4 dflt) internal pure returns (bytes4) {
        bytes4 s = bytes4(a);
        return s == bytes4(0) ? dflt : s;
    }

    /// @dev One capped read of the target. `exhausted`: the call failed after using its whole cap (out of gas or INVALID).
    function _targetRead(address target, bytes memory data, uint256 words)
        internal
        view
        returns (bool ok, bool exhausted, uint256[5] memory w)
    {
        if (gasleft() < TARGET_READ_GAS + READ_GAS_OVERHEAD) revert NotEnoughGas();
        bool succeeded;
        uint256 used;
        (ok, succeeded, w, used) = CappedCall.read(target, data, TARGET_READ_GAS, words);
        exhausted = !succeeded && used >= TARGET_READ_GAS;
    }

    function _sharePrice(address vault) internal view returns (bool, uint256) {
        (bool ok,, uint256[5] memory w) = _targetRead(vault, abi.encodeWithSelector(0x313ce567), 1); // decimals()
        if (!ok || w[0] > 36) return (false, 0);
        (ok,, w) = _targetRead(vault, abi.encodeWithSelector(0x07a2d13a, 10 ** w[0]), 1); // convertToAssets(uint256)
        return ok && w[0] <= MAX_READING ? (true, w[0]) : (false, 0);
    }

    function _totalAssets(address vault) internal view returns (bool, uint256) {
        (bool ok,, uint256[5] memory w) = _targetRead(vault, abi.encodeWithSelector(0x01e1d114), 1); // totalAssets()
        return ok && w[0] <= MAX_READING ? (true, w[0]) : (false, 0);
    }

    function _readAddress(address target, bytes4 sel) internal view returns (bool, uint256) {
        if (sel == bytes4(0)) return (false, 0);
        (bool ok,, uint256[5] memory w) = _targetRead(target, abi.encodeWithSelector(sel), 1);
        if (!ok || w[0] > type(uint160).max) return (false, 0);
        return (true, w[0]);
    }
}
