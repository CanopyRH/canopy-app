// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitRouter} from "../src/ExitRouter.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {MockERC20, MockVault, MockFeed, MockSwapRouter, MockPausable} from "./Mocks.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function assume(bool) external;
    function deal(address, uint256) external;
    function envString(string calldata) external returns (string memory);
    function createSelectFork(string calldata) external returns (uint256);
}

abstract contract Base {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant OWNER = address(0xA11CE);
    address internal constant KEEPER = address(0xB0B);
    address internal constant ATTACKER = address(0xBAD);
    address internal constant ADMIN = address(0xAD);
    address internal constant GUARD = address(0x6A);
    bytes32 internal constant TERMS = keccak256("terms-v1");
    uint256 internal constant EXPIRY_FROM_START = 365 days;

    MockERC20 internal stable;
    MockERC20 internal weth;
    MockFeed internal stableFeed;
    MockSwapRouter internal swap;
    AlarmBook internal book;
    ExitRouter internal router;
    ERC4626Adapter internal adapter;
    MockVault internal vault;
    MockPausable internal pausable;
    bytes32 internal pauseKey;
}
