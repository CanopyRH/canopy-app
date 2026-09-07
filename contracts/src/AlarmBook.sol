// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC4626, IAggregatorV3} from "./interfaces/IExternal.sol";
import {IAlarmBook} from "./interfaces/IAlarmBook.sol";
import {SignatureChecker} from "./lib/SignatureChecker.sol";

/// @title AlarmBook
/// @notice Permissionless registry of danger detectors. Anyone can register a detector, anyone can `poke`
/// it, and it fires when its on-chain condition holds. Users choose which detector keys to arm per
/// position in ExitRouter; a live alarm lets ANY keeper exit those positions back to their owners.
/// Kinds:
///   PRICE_BELOW     Chainlink feed answer below `threshold` and fresher than `window` s.
///   SHARE_DROP      ERC-4626 share price fell more than `threshold` bps under its high-water mark.
///   PAUSED          target's bool view (`a` = selector, default paused()) returns true.
///   ADDRESS_CHANGE  target's address view (`a` = selector) differs from the registered value.
///   DRAIN           ERC-4626 totalAssets fell more than `threshold` bps under a snapshot <= `window` s old.
///   QUORUM          k = `threshold` distinct approved watchers signed an attestation.
///   BOTH            keys `a` and `b` both fired within `window` s of now.
/// An alarm can never move funds; it only widens who may call ExitRouter.exit, which pays the owner only.
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
    }

    bytes32 public constant ATTEST_TYPEHASH = keccak256("Attest(bytes32 key,bytes32 evidence,uint64 deadline)");
    uint256 public constant REFIRE_AFTER = 1 days;
    uint256 public constant MAX_QUORUM = 32;
    uint256 public constant MAX_ATTEST_LIFE = 1 hours; // shorter than REFIRE_AFTER, so signatures can't fire twice

    address public immutable ADMIN; // the Timelock
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address => bool) public isWatcher;
    mapping(bytes32 => Detector) internal _detectors;
    mapping(bytes32 => State) public state;
    mapping(bytes32 => address[]) internal _signers;

    event Registered(bytes32 indexed key, Kind kind, address indexed target, uint256 threshold, uint32 window, bytes32 a, bytes32 b);
    event Fired(bytes32 indexed key, Kind kind, address indexed target, address by, bytes32 evidence);
    event Checkpoint(bytes32 indexed key, uint256 value);
    event WatcherSet(address indexed watcher, bool allowed);

    error NotAdmin();
    error Unknown();
    error BadDetector();
    error NotQuorumKind();
    error Expired();
    error DeadlineTooFar();
    error AlreadyLive();
    error BadSigners();
    error NotWatcher(address who);
    error BadSignature(address who);

    constructor(address admin) {
        ADMIN = admin;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Canopy AlarmBook"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Watcher list. Stays with the Timelock so a bad watcher can always be removed.
    function setWatcher(address w, bool allowed) external {
        if (msg.sender != ADMIN) revert NotAdmin();
        isWatcher[w] = allowed;
        emit WatcherSet(w, allowed);
    }

    // ------------------------------------------------------------------ registry

    function keyOf(Detector memory d) public pure returns (bytes32) {
        return keccak256(abi.encode(d.kind, d.target, d.threshold, d.window, d.a, d.b));
    }

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
            (bool ok, address v) = _readAddress(d.target, _sel(d.a, bytes4(0)));
            if (!ok) revert BadDetector();
            s.baseline = uint256(uint160(v));
        } else if (d.kind == Kind.DRAIN) {
            (bool ok, uint256 ta) = _totalAssets(d.target);
            if (!ok || ta == 0) revert BadDetector();
            s.baseline = ta; // A candidate only. Nothing can fire until a later period has confirmed it.
            s.snapAt = uint64(block.timestamp);
        }
        emit Registered(key, d.kind, d.target, d.threshold, d.window, d.a, d.b);
    }

    function detector(bytes32 key) external view returns (Detector memory) {
        return _detectors[key];
    }

    function signersOf(bytes32 key) external view returns (address[] memory) {
        return _signers[key];
    }

    // ------------------------------------------------------------------ firing

    /// @notice View used by keepers: would `poke(key)` fire right now?
    function check(bytes32 key) public view returns (bool) {
        State storage s = state[key];
        if (!s.exists) return false;
        if (_liveNow(s)) return false;
        return _tripped(key, s);
    }

    function poke(bytes32 key) external returns (bool fired) {
        State storage s = state[key];
        if (!s.exists) revert Unknown();
        if (_liveNow(s) || !_tripped(key, s)) return false;
        _fire(key, s, bytes32(0));
        return true;
    }

    /// @notice Rolls baselines forward. The SHARE_DROP high-water mark only rises.
    /// DRAIN never trusts one reading, because anyone can call this inside a flash deposit. Calls sample totalAssets, and
    /// every window/2 the lowest sample of the period becomes the baseline. So an inflated reading only counts if it
    /// survives a whole period of samples, and a keeper sampling once a period is enough. Nothing rolls while the
    /// detector is tripped, so a drain cannot be "reset" away.
    function checkpoint(bytes32 key) external {
        State storage s = state[key];
        if (!s.exists) revert Unknown();
        Detector memory d = _detectors[key];
        if (_tripped(key, s)) return;
        if (d.kind == Kind.SHARE_DROP) {
            (bool ok, uint256 px) = _sharePrice(d.target);
            if (ok && px > s.baseline) {
                s.baseline = px;
                emit Checkpoint(key, px);
            }
        } else if (d.kind == Kind.DRAIN) {
            (bool ok, uint256 ta) = _totalAssets(d.target);
            if (!ok || ta == 0) return;
            if (block.timestamp < uint256(s.snapAt) + d.window / 2) {
                if (ta < s.baseline) s.baseline = ta;
                return;
            }
            s.snap = s.baseline;
            s.baseline = ta;
            s.snapAt = uint64(block.timestamp);
            emit Checkpoint(key, s.snap);
        }
    }

    function attestDigest(bytes32 key, bytes32 evidence, uint64 deadline) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(ATTEST_TYPEHASH, key, evidence, deadline)))
        );
    }

    /// @notice Fire a QUORUM alarm with k distinct approved watcher signatures (signers sorted ascending).
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
            if (!isWatcher[w]) revert NotWatcher(w);
            if (!SignatureChecker.isValidSignatureNow(w, digest, sigs[i])) revert BadSignature(w);
        }
        _signers[key] = signers;
        _fire(key, s, evidence);
    }

    function isLive(bytes32 key, uint256 ttl) external view returns (bool) {
        State storage s = state[key];
        return s.firedAt != 0 && block.timestamp <= uint256(s.firedAt) + ttl;
    }

    // ------------------------------------------------------------------ internals

    function _fire(bytes32 key, State storage s, bytes32 evidence) internal {
        s.firedAt = uint64(block.timestamp);
        Detector memory d = _detectors[key];
        emit Fired(key, d.kind, d.target, msg.sender, evidence);
    }

    function _liveNow(State storage s) internal view returns (bool) {
        return s.firedAt != 0 && block.timestamp < uint256(s.firedAt) + REFIRE_AFTER;
    }

    function _validate(Detector calldata d) internal view {
        Kind k = d.kind;
        if (k == Kind.PRICE_BELOW) {
            if (d.threshold == 0 || d.window == 0 || d.target.code.length == 0) revert BadDetector();
        } else if (k == Kind.SHARE_DROP || k == Kind.DRAIN) {
            if (d.threshold == 0 || d.threshold >= 10_000 || d.target.code.length == 0) revert BadDetector();
            if (k == Kind.DRAIN && d.window == 0) revert BadDetector();
        } else if (k == Kind.PAUSED || k == Kind.ADDRESS_CHANGE) {
            if (d.target.code.length == 0) revert BadDetector();
        } else if (k == Kind.QUORUM) {
            if (d.threshold < 2 || d.threshold > MAX_QUORUM) revert BadDetector();
        } else if (k == Kind.BOTH) {
            // A part can't refire for REFIRE_AFTER, so any shorter window could close on a part that can't refresh.
            if (!state[d.a].exists || !state[d.b].exists || d.a == d.b || d.window < REFIRE_AFTER) revert BadDetector();
        }
    }

    function _tripped(bytes32 key, State storage s) internal view returns (bool) {
        Detector memory d = _detectors[key];
        Kind k = d.kind;
        if (k == Kind.PRICE_BELOW) {
            try IAggregatorV3(d.target).latestRoundData() returns (uint80, int256 ans, uint256, uint256 upd, uint80) {
                if (ans <= 0 || upd == 0 || upd > block.timestamp || block.timestamp - upd > d.window) return false;
                return uint256(ans) < d.threshold;
            } catch {
                return false;
            }
        }
        if (k == Kind.SHARE_DROP) {
            (bool ok, uint256 px) = _sharePrice(d.target);
            return ok && px * 10_000 < s.baseline * (10_000 - d.threshold);
        }
        if (k == Kind.PAUSED) {
            (bool ok, bytes memory ret) =
                d.target.staticcall(abi.encodeWithSelector(_sel(d.a, bytes4(keccak256("paused()")))));
            return ok && ret.length >= 32 && abi.decode(ret, (uint256)) == 1;
        }
        if (k == Kind.ADDRESS_CHANGE) {
            (bool ok, address v) = _readAddress(d.target, _sel(d.a, bytes4(0)));
            return ok && uint256(uint160(v)) != s.baseline;
        }
        if (k == Kind.DRAIN) {
            if (s.snap == 0 || block.timestamp - s.snapAt > d.window) return false;
            (bool ok, uint256 ta) = _totalAssets(d.target);
            return ok && ta * 10_000 < s.snap * (10_000 - d.threshold);
        }
        if (k == Kind.BOTH) {
            return _firedWithin(state[d.a], d.window) && _firedWithin(state[d.b], d.window);
        }
        return false; // QUORUM fires only through fireByQuorum
    }
}
