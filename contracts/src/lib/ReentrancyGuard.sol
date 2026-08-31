// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Clone-friendly reentrancy guard (zero-initialised storage counts as "not entered").
abstract contract ReentrancyGuard {
    uint256 private _status; // 0/1 = not entered, 2 = entered

    error Reentrancy();

    modifier nonReentrant() {
        if (_status == 2) revert Reentrancy();
        _status = 2;
        _;
        _status = 1;
    }
}
