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
}
