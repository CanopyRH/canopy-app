// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAlarmBook} from "../interfaces/IAlarmBook.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";

/// @notice Owner-authorized policy records for off-chain venues. Holds no funds or venue credentials.
/// @dev CloseReported is an executor attestation, NOT an on-chain proof that an exchange filled an order.
contract PerpsArmBook is ReentrancyGuard {
    IAlarmBook public immutable ALARM_BOOK;

    struct Policy {
        address owner;
        address executor;
        address referenceFeed;
        bytes32 venue;
        bytes32 account;
        bytes32 market;
        bytes32 terms;
        uint256 remainingSize;
        uint64 expiresAt;
        uint64 revision;
        uint32 referenceHeartbeat;
        uint16 maxCloseBps;
        uint16 maxSlippageBps;
        bool active;
    }

    struct Arm {
        address executor;
        address referenceFeed;
        bytes32 venue;
        bytes32 account;
        bytes32 market;
        bytes32 terms;
        uint256 maxSize;
        uint64 expiresAt;
        uint32 referenceHeartbeat;
        uint16 maxCloseBps;
        uint16 maxSlippageBps;
        bytes32[] keys;
    }
    mapping(bytes32 => Policy) private _policies;
    mapping(bytes32 => bytes32[]) private _keys;
    mapping(bytes32 => bool) public reported;
    error InvalidPolicy();
    error Unauthorized();
    error NoLiveAlarm();
    error DuplicateReceipt();
    event Armed(bytes32 indexed id, address indexed owner, uint64 revision, bytes32 policyHash);
    event Disarmed(bytes32 indexed id, uint64 revision);
    event CloseReported(
        bytes32 indexed id,
        uint64 revision,
        bytes32 indexed receiptHash,
        bytes32 alarmKey,
        uint256 size,
        uint64 filledAt
    );

    constructor(address alarmBook) {
        if (alarmBook.code.length == 0) revert InvalidPolicy();
        ALARM_BOOK = IAlarmBook(alarmBook);
    }

    function positionId(address owner, bytes32 venue, bytes32 account, bytes32 market) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, venue, account, market));
    }

    function policy(bytes32 id) external view returns (Policy memory) {
        return _policies[id];
    }

    function keysOf(bytes32 id) external view returns (bytes32[] memory) {
        return _keys[id];
    }

    function policyHash(bytes32 id) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), id, _policies[id], _keys[id]));
    }

    function arm(Arm calldata a) external nonReentrant returns (bytes32 id) {
        if (
            a.executor == address(0) || a.referenceFeed.code.length == 0 || a.venue == 0 || a.account == 0
                || a.market == 0 || a.terms == 0 || a.maxSize == 0 || a.expiresAt <= block.timestamp
                || a.expiresAt > block.timestamp + 365 days || a.maxCloseBps == 0 || a.maxCloseBps > 10_000
                || a.maxSlippageBps > 100 || a.referenceHeartbeat == 0 || a.referenceHeartbeat > 2 days
                || a.keys.length == 0 || a.keys.length > 8
        ) revert InvalidPolicy();
        id = positionId(msg.sender, a.venue, a.account, a.market);
        uint64 revision = _policies[id].revision + 1;
        delete _keys[id];
        for (uint256 i; i < a.keys.length; i++) {
            if (!ALARM_BOOK.armable(a.keys[i])) revert InvalidPolicy();
            for (uint256 j; j < i; j++) {
                if (a.keys[i] == a.keys[j]) revert InvalidPolicy();
            }
            _keys[id].push(a.keys[i]);
        }
        _policies[id] = Policy(
            msg.sender,
            a.executor,
            a.referenceFeed,
            a.venue,
            a.account,
            a.market,
            a.terms,
            a.maxSize,
            a.expiresAt,
            revision,
            a.referenceHeartbeat,
            a.maxCloseBps,
            a.maxSlippageBps,
            true
        );
        emit Armed(id, msg.sender, revision, policyHash(id));
    }

    function disarm(bytes32 id) external nonReentrant {
        Policy storage p = _policies[id];
        if (p.owner != msg.sender) revert Unauthorized();
        p.active = false;
        p.revision++;
        emit Disarmed(id, p.revision);
    }

    function executable(bytes32 id, uint64 revision, bytes32 alarmKey) public view returns (bool) {
        Policy storage p = _policies[id];
        if (!p.active || p.revision != revision || block.timestamp >= p.expiresAt || p.remainingSize == 0) {
            return false;
        }
        for (uint256 i; i < _keys[id].length; i++) {
            if (_keys[id][i] == alarmKey) return ALARM_BOOK.isLive(alarmKey, 1 days);
        }
        return false;
    }

    /// @dev Off-chain execution must re-check executable immediately before signing and use venue reduce-only.
    /// Owner disarm cannot cancel an exchange order already submitted; the venue's cancel API is separate.
    function recordClose(
        bytes32 id,
        uint64 revision,
        bytes32 alarmKey,
        bytes32 receiptHash,
        uint256 size,
        uint64 filledAt
    ) external nonReentrant {
        Policy storage p = _policies[id];
        if (msg.sender != p.executor) revert Unauthorized();
        if (!executable(id, revision, alarmKey)) revert NoLiveAlarm();
        if (
            receiptHash == 0 || size == 0 || size > p.remainingSize || filledAt == 0 || filledAt > block.timestamp
                || block.timestamp - filledAt > 1 days
        ) revert InvalidPolicy();
        bytes32 receiptId = keccak256(abi.encode(id, receiptHash));
        if (reported[receiptId]) revert DuplicateReceipt();
        reported[receiptId] = true;
        p.remainingSize -= size;
        if (p.remainingSize == 0) p.active = false;
        emit CloseReported(id, revision, receiptHash, alarmKey, size, filledAt);
    }
}
