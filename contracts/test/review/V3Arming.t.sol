// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.sol";
import {AlarmBook} from "../../src/AlarmBook.sol";
import {ExitRouter} from "../../src/ExitRouter.sol";
import {MockERC20, MockVault, MockFeed} from "../Mocks.sol";
import {RealVault} from "../AlarmAttacks.t.sol";
import {Whale} from "../AlarmLimits.t.sol";

/// @notice V3-03 and V3-04: two things `arm` accepts that it could cheaply refuse.
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

    /// V3-03. `tokenDecimals` is taken on trust (only `<= 36` is checked) and never compared with the token's own
    /// `decimals()`. A leg that states more decimals than the token has (for example the vault share's 18 for a
    /// 6-decimal asset, or here 24 for an 18-decimal one) shrinks the oracle minimum by 10^k, so any keeper exit swaps
    /// through a pool the keeper skewed, and the 1% third-party cap (R10) protects nothing. A $100 position pays $0.0001.
    function test_V3_03_wrongLegDecimals_letAKeeperSwapAtAnyPrice() public {
        bytes32 id = _setupSwap(OWNER, tVault, 1e18, 50, _legWithDecimals(24));
        swap.setRate(100); // the keeper's sandwiched pool: 0.0001 stable per token
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(t.balanceOf(OWNER), 0, "the token was swapped");
        assertEq(stable.balanceOf(OWNER), 100, "for 0.0001 of the stablecoin instead of 100");
        (bool ok, uint256 minOut) = router.quoteMinOut(address(tFeed), 3600, 24, 1e18, 100);
        assertTrue(ok && minOut == 99, "the oracle bound the router used");
    }

    /// Control: with the token's true decimals the same pool is refused and the raw token is delivered.
    function test_V3_03_control_trueDecimalsSkipTheBadPool() public {
        bytes32 id = _setupSwap(OWNER, tVault, 1e18, 50, _legWithDecimals(18));
        swap.setRate(100);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(t.balanceOf(OWNER), 1e18, "raw token delivered");
        assertEq(stable.balanceOf(OWNER), 0, "no swap");
    }

    /// V3-04. `armable` reads only the current reading and the last fire. A DRAIN key with a live pending sighting
    /// (taken before the arming) is armable, and one more sighting after the arming fires it at once, so half of the
    /// "fire at or after arming" evidence predates the arming. Here a 40% holder dips once before the owner arms and once
    /// 70 seconds later; the owner is exited by a keeper with no loss in the vault (the documented whale limit, now
    /// reaching a position armed after the first dip).
    function test_V3_04_pendingSightingBeforeArming_countsTowardAFireAfterIt() public {
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
        book.checkpoint(key); // reference 1000

        assertTrue(!whale.dip(book, rv, key, 400e18, true), "first dip: a pending sighting");
        (,,,,,, uint64 pendingAt) = book.state(key);
        assertTrue(pendingAt != 0, "pending");

        vm.warp(block.timestamp + 10);
        assertTrue(book.armable(key), "armable while a sighting is pending");
        vm.prank(OWNER);
        rv.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(rv), 0, 0, _keys(key)));

        vm.warp(block.timestamp + 60);
        assertTrue(whale.dip(book, rv, key, 400e18, true), "one dip after arming fires it");
        vm.prank(KEEPER);
        router.exit(id, key, 0);
        assertEq(asset.balanceOf(OWNER), 600e18, "exited on a drain that never happened");
    }
}
