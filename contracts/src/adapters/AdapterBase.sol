// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Shared guard: adapters only act for the ExitRouter they were wired to.
abstract contract AdapterBase {
    address public immutable ROUTER;

    error OnlyRouter();
    error WrongTarget();

    constructor(address router) {
        ROUTER = router;
    }

    modifier onlyRouter() {
        if (msg.sender != ROUTER) revert OnlyRouter();
        _;
    }
}
