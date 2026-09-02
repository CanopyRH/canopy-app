// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IAlarmBook {
    /// @notice true if `key` fired no more than `ttl` seconds ago.
    function isLive(bytes32 key, uint256 ttl) external view returns (bool);
}
