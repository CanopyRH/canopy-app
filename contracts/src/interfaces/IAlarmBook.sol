// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice What ExitRouter reads from AlarmBook.
interface IAlarmBook {
    /// @notice True if `key` fired no more than `ttl` seconds ago.
    /// @param key The detector key.
    /// @param ttl How far back a fire still counts.
    /// @return True if it fired within `ttl`.
    function isLive(bytes32 key, uint256 ttl) external view returns (bool);

    /// @notice True if `key` exists, reads clear now (a failed read is not clear) and has not fired within REFIRE_AFTER.
    /// @param key The detector key.
    /// @return True if the key may be armed.
    function armable(bytes32 key) external view returns (bool);
}

/// @notice AlarmBook's `detector(key)`, with the Detector struct flattened (a static tuple encodes the same either way),
/// so ExitRouter can read a key's kind without importing AlarmBook.
interface IAlarmBookDetector {
    /// @notice A registered detector (all zero for an unknown key).
    /// @param key The detector key.
    /// @return kind The kind (AlarmBook.Kind; DRAIN is 4).
    /// @return target What it reads.
    /// @return threshold Its threshold.
    /// @return window Its window.
    /// @return a Selector or first part.
    /// @return b Second part.
    function detector(bytes32 key)
        external
        view
        returns (uint8 kind, address target, uint256 threshold, uint32 window, bytes32 a, bytes32 b);
}
