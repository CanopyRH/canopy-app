// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.sol";
import {AlarmBook} from "../../src/AlarmBook.sol";
import {ExitRouter} from "../../src/ExitRouter.sol";
import {MockERC20} from "../Mocks.sol";
import {RealVault} from "../AlarmAttacks.t.sol";
import {Whale} from "../AlarmLimits.t.sol";

/// @notice V3B-01, regression. At 466c807 `arm` refused a bare DRAIN key but never looked inside a BOTH key, so a BOTH of
/// two DRAIN keys on the same vault (thresholds 25% and 25.01%), or of a DRAIN and any non-quorum key, armed fine, and the
/// documented whale dip fired it: a keeper exited the owner with no watcher signature and no loss. Fixed: `arm` reads a
/// BOTH key's two parts from AlarmBook's stored detectors and refuses (DrainNeedsQuorum) a DRAIN part whose other part
/// is not a QUORUM key, and refuses (NestedBoth) any BOTH part.
contract V3VerifyBTest is Base {
    uint32 internal constant WINDOW = 3600;

    MockERC20 internal asset;
    RealVault internal rv;
    Whale internal whale;
    bytes32 internal d1;
    bytes32 internal d2;

    function setUp() public override {
        super.setUp();
        asset = new MockERC20(18);
        rv = new RealVault(asset);
        whale = new Whale();
        asset.mint(address(whale), 400e18);
        whale.deposit(rv, 400e18);
        asset.mint(OWNER, 600e18);
        vm.prank(OWNER);
        asset.approve(address(rv), 600e18);
        vm.prank(OWNER);
        rv.deposit(600e18, OWNER);
        d1 = book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2500, WINDOW, 0, 0));
        d2 = book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2501, WINDOW, 0, 0));
        for (uint256 i; i < 2; ++i) {
            vm.warp(block.timestamp + WINDOW / 2);
            book.checkpoint(d1);
            book.checkpoint(d2);
        }
        vm.prank(OWNER);
        rv.approve(address(router), type(uint256).max);
    }


    /// Control: the fix refuses the bare DRAIN key.
    function test_V3B_control_bareDrainIsRefused() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.DrainNeedsQuorum.selector, d1));
        router.arm(_params(address(rv), 0, 0, _keys(d1)));
    }

    /// V3B-01, regression: a BOTH of two DRAIN keys is refused at arming.
    function test_V3B_01_bothOfTwoDrains_isRefused() public {
        bytes32 both = book.register(_detector(AlarmBook.Kind.BOTH, address(rv), 0, 1 days, d1, d2));
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.DrainNeedsQuorum.selector, both));
        router.arm(_params(address(rv), 0, 0, _keys(both)));

        // The whale's dips still fire both DRAIN parts and the BOTH key, but no position can carry it.
        whale.dip(book, rv, d1, 400e18, true);
        whale.dip(book, rv, d2, 400e18, true);
        vm.warp(block.timestamp + 60);
        assertTrue(whale.dip(book, rv, d1, 400e18, true), "first DRAIN part fires");
        assertTrue(whale.dip(book, rv, d2, 400e18, true), "second DRAIN part fires");
        assertTrue(book.poke(both), "the BOTH key fires in AlarmBook");
        assertTrue(!router.isArmed(router.positionId(OWNER, address(adapter), address(rv), 0)), "but nobody is armed on it");
        assertEq(rv.balanceOf(OWNER), 600e18, "the owner keeps the position");
    }

    /// The same for BOTH(DRAIN, X) with any non-quorum X, in either order. Here X is a PAUSED key anyone can trip.
    function test_V3B_01_bothOfDrainAndANonQuorumKey_isRefused_eitherOrder() public {
        bytes32 b1 = book.register(_detector(AlarmBook.Kind.BOTH, address(rv), 0, 1 days, d1, pauseKey));
        bytes32 b2 = book.register(_detector(AlarmBook.Kind.BOTH, address(rv), 0, 1 days, pauseKey, d1));
        bytes32[2] memory bs = [b1, b2];
        for (uint256 i; i < 2; ++i) {
            vm.prank(OWNER);
            vm.expectRevert(abi.encodeWithSelector(ExitRouter.DrainNeedsQuorum.selector, bs[i]));
            router.arm(_params(address(rv), 0, 0, _keys(bs[i])));
        }
    }

    /// A nested BOTH is refused, even when its inner key is the allowed BOTH(DRAIN, QUORUM), so one level of parts is the
    /// whole tree the router has to check. The inner key itself, the app's "Vault drain + confirmation" shape, arms.
    function test_V3B_01_nestedBoth_isRefused() public {
        bytes32 q = book.register(_detector(AlarmBook.Kind.QUORUM, address(rv), 2, 0, 0, 0));
        bytes32 inner = book.register(_detector(AlarmBook.Kind.BOTH, address(rv), 0, 1 days, d1, q));
        bytes32 outer = book.register(_detector(AlarmBook.Kind.BOTH, address(rv), 0, 1 days, inner, pauseKey));
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.NestedBoth.selector, outer));
        router.arm(_params(address(rv), 0, 0, _keys(outer)));
        vm.prank(OWNER);
        router.arm(_params(address(rv), 0, 0, _keys(inner)));
    }
}
