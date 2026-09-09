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

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        stable = new MockERC20(6);
        weth = new MockERC20(18);
        stableFeed = new MockFeed(1e8);
        swap = new MockSwapRouter(stable);
        book = new AlarmBook(ADMIN);
        router = new ExitRouter(
            address(stable),
            address(weth),
            address(swap),
            address(book),
            ADMIN,
            GUARD,
            address(stableFeed),
            90_000,
            block.timestamp + EXPIRY_FROM_START
        );
        adapter = new ERC4626Adapter(address(router));
        vm.prank(ADMIN);
        router.setAdapter(address(adapter), true);
        vault = new MockVault(stable, 1e6); // 1 share = 1 USD
        pausable = new MockPausable();
        pauseKey = book.register(_detector(AlarmBook.Kind.PAUSED, address(pausable), 0, 0, 0, 0));
    }

    function _detector(AlarmBook.Kind k, address t, uint256 th, uint32 w, bytes32 a, bytes32 b)
        internal
        pure
        returns (AlarmBook.Detector memory)
    {
        return AlarmBook.Detector({kind: k, target: t, threshold: th, window: w, a: a, b: b});
    }

    function _keys(bytes32 k) internal pure returns (bytes32[] memory a) {
        a = new bytes32[](1);
        a[0] = k;
    }

    function _params(address target, uint8 harbour, uint16 slip, bytes32[] memory keys)
        internal
        view
        returns (ExitRouter.ArmParams memory)
    {
        return ExitRouter.ArmParams({
            adapter: address(adapter),
            target: target,
            tokenId: 0,
            harbour: harbour,
            maxSlipBps: slip,
            termsHash: TERMS,
            keys: keys
        });
    }

    /// @dev Deposits `shares`, approves the router and arms with pauseKey.
    function _setup(address who, MockVault v, uint256 shares, uint8 harbour, uint16 slip) internal returns (bytes32 posId) {
        v.deposit(who, shares);
        vm.prank(who);
        v.approve(address(router), type(uint256).max);
        vm.prank(who);
        posId = router.arm(_params(address(v), harbour, slip, _keys(pauseKey)));
    }

    function _fireAlarm() internal {
        pausable.setPaused(true);
        assertTrue(book.poke(pauseKey), "poke");
    }

    function assertTrue(bool c, string memory m) internal pure {
        require(c, m);
    }

    function assertEq(uint256 a, uint256 b, string memory m) internal pure {
        if (a != b) revert(string.concat(m, ": ", _u(a), " != ", _u(b)));
    }

    function _u(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 d;
        for (uint256 x = v; x > 0; x /= 10) d++;
        bytes memory b = new bytes(d);
        for (; v > 0; v /= 10) b[--d] = bytes1(uint8(48 + (v % 10)));
        return string(b);
    }
}
