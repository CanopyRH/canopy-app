// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {SafeTransferLib} from "../src/lib/SafeTransferLib.sol";
import {AdapterBase} from "../src/adapters/AdapterBase.sol";
import {ReentrancyGuard} from "../src/lib/ReentrancyGuard.sol";
import {MockERC20, MockVault, MockFeed, EvilAdapter, EvilVault, ReentrantVault, SelfAssetVault} from "./Mocks.sol";

contract ExitRouterTest is Base {
    uint8 internal constant RAW = 0;
    uint8 internal constant STABLE = 1;
    MockERC20 internal t;
    MockFeed internal tFeed;
    MockVault internal tVault;

    function setUp() public override {
        super.setUp();
        t = new MockERC20(18);
        tFeed = new MockFeed(100e8); // $100
        tVault = new MockVault(t, 1e18); // 1 share = 1 token
        vm.startPrank(ADMIN);
        router.setFeed(address(t), address(tFeed), 3600, 18);
        router.setRoute(address(t), abi.encodePacked(address(t), uint24(500), address(stable)));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- arming

    function test_arm_rejectsUnlistedAdapter() public {
        ExitRouter.ArmParams memory p = _params(address(vault), RAW, 0, _keys(pauseKey));
        p.adapter = address(0x1234);
        vm.expectRevert(ExitRouter.NotSupported.selector);
        router.arm(p);
    }

    function test_arm_rejectsSlipAboveCap() public {
        vm.expectRevert(ExitRouter.SlipTooHigh.selector);
        router.arm(_params(address(vault), RAW, 1001, _keys(pauseKey)));
    }
}
