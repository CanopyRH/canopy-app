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
}
