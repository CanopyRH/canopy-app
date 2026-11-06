// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Shared guard: adapters only act for the ExitRouter they were wired to.
abstract contract AdapterBase {
    /// @notice The only ExitRouter this adapter acts for.
    address public immutable ROUTER;

    /// @notice The caller is not ROUTER.
    error OnlyRouter();

    /// @param router The ExitRouter (may be its predicted address, deployed right after this adapter).
    constructor(address router) {
        ROUTER = router;
    }

    modifier onlyRouter() {
        if (msg.sender != ROUTER) revert OnlyRouter();
        _;
    }
}
