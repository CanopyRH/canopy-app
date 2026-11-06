// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.sol";
import {AlarmBook} from "../../src/AlarmBook.sol";
import {ExitRouter} from "../../src/ExitRouter.sol";
import {MockERC20, MockVault, MockFeed} from "../Mocks.sol";
import {RealVault} from "../AlarmAttacks.t.sol";
import {Whale} from "../AlarmLimits.t.sol";

/// @notice V3-03 and V3-04, regressions: two things `arm` used to accept and now refuses.
contract V3ArmingTest is Base {
    uint32 internal constant WINDOW = 3600;
    MockERC20 internal t;
    MockFeed internal tFeed;
    MockVault internal tVault;

    function setUp() public override {
        super.setUp();
        t = new MockERC20(18);
        tFeed = new MockFeed(100e8); // $100
        tVault = new MockVault(t, 1e18); // 1 share = 1 token
    }

    function _legWithDecimals(uint8 dec) internal view returns (ExitRouter.SwapLeg[] memory) {
        ExitRouter.SwapLeg memory l = _leg(address(t), address(tFeed));
        l.tokenDecimals = dec;
        return _legs(l);
    }

    /// V3-03, regression. In v2 as reviewed `tokenDecimals` was taken on trust (only `<= 36` was checked). A leg that
    /// stated more decimals than the token has (24 for an 18-decimal token here) shrank the oracle minimum by 10^6, so a
    /// keeper could swap a $100 position for $0.0001 through a pool it skewed. Fixed: `arm` reads the token's own
    /// `decimals()` (gas-capped) and refuses a leg that states anything else.
    function test_V3_03_wrongLegDecimals_areRefusedAtArming() public {
        tVault.deposit(OWNER, 1e18);
        vm.prank(OWNER);
        tVault.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.BadFeed.selector);
        router.arm(_swapParams(address(tVault), 50, _keys(pauseKey), _legWithDecimals(24)));
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.BadFeed.selector);
        router.arm(_swapParams(address(tVault), 50, _keys(pauseKey), _legWithDecimals(6)));
    }

    /// Control: with the token's true decimals the arming works, and the skewed pool is refused at exit, so the raw
    /// token is delivered.
    function test_V3_03_control_trueDecimalsSkipTheBadPool() public {
        bytes32 id = _setupSwap(OWNER, tVault, 1e18, 50, _legWithDecimals(18));
        swap.setRate(100);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(t.balanceOf(OWNER), 1e18, "raw token delivered");
        assertEq(stable.balanceOf(OWNER), 0, "no swap");
    }

    /// V3-04, regression. In v2 as reviewed `armable` read only the current reading and the last fire, so a DRAIN key
    /// with a pending sighting from before the arming could be armed, and one more sighting after it fired the key: half
    /// of the "fire at or after the arming" evidence predated the arming. Fixed: a DRAIN key is not armable while a
    /// sighting is pending. Once the sighting lapses (after the window), the key can be armed, and a fire needs two fresh
    /// sightings.
    function test_V3_04_pendingSightingBlocksArming_untilItLapses() public {
        MockERC20 asset = new MockERC20(18);
        RealVault rv = new RealVault(asset);
        Whale whale = new Whale();
        asset.mint(address(whale), 400e18);
        whale.deposit(rv, 400e18);
        asset.mint(OWNER, 600e18);
        vm.prank(OWNER);
        asset.approve(address(rv), 600e18);
        vm.prank(OWNER);
        rv.deposit(600e18, OWNER);
        bytes32 key = book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2500, WINDOW, 0, 0));
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key);
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key); // reference min(1000, 1000), live

        assertTrue(!whale.dip(book, rv, key, 400e18, true), "first dip: a pending sighting");
        (,,,,,, uint64 pendingAt,) = book.state(key);
        assertTrue(pendingAt != 0, "pending");

        vm.warp(block.timestamp + 10);
        assertTrue(!book.armable(key), "not armable while a sighting is pending");
        vm.prank(OWNER);
        rv.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.AlarmNotClear.selector, key));
        router.arm(_params(address(rv), 0, 0, _keys(key)));

        // After the window the sighting has lapsed; a keeper's sample keeps the reference live, and arming works.
        vm.warp(uint256(pendingAt) + WINDOW + 1);
        book.checkpoint(key);
        assertTrue(book.armable(key), "armable once the sighting lapsed");
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(rv), 0, 0, _keys(key)));

        // One dip after the arming only starts a new sighting: it can't complete the old one.
        assertTrue(!whale.dip(book, rv, key, 400e18, true), "a dip after arming only starts a fresh sighting");
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, key, 0);
        assertEq(rv.balanceOf(OWNER), 600e18, "the owner keeps the position");
    }
}
