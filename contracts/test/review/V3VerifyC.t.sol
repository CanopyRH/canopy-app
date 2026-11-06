// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.sol";
import {AlarmBook} from "../../src/AlarmBook.sol";
import {ExitRouter} from "../../src/ExitRouter.sol";
import {MockERC20} from "../Mocks.sol";
import {RealVault} from "../AlarmAttacks.t.sol";
import {Whale} from "../AlarmLimits.t.sol";

/// @notice V3C-01, regression. A BOTH key's window has only a lower bound in AlarmBook (REFIRE_AFTER), and the owner
/// picks it. With a 30-day BOTH(DRAIN, QUORUM) key, a quorum signed ten days earlier (before the arming) plus a whale's
/// two dips today exited the owner. Fixed: `arm` refuses (DrainNeedsQuorum) a BOTH key with a DRAIN part unless its
/// window is exactly one day, the app preset's value, so the watchers' signatures behind any DRAIN exit are at most a day
/// older than the DRAIN fire.
contract V3VerifyCTest is Base {
    uint256 internal constant PK_A = 0xA1;
    uint256 internal constant PK_B = 0xB2;
    uint32 internal constant WINDOW = 3600;

    function _initialWatchers() internal override returns (address[] memory) {
        return _addrs(vm.addr(PK_A), vm.addr(PK_B));
    }

    function _fireQuorum(bytes32 q) internal {
        uint64 dl = uint64(block.timestamp + 600);
        bytes32 digest = book.attestDigest(q, keccak256("report"), dl);
        (uint256 lo, uint256 hi) = vm.addr(PK_A) < vm.addr(PK_B) ? (PK_A, PK_B) : (PK_B, PK_A);
        address[] memory s = new address[](2);
        bytes[] memory g = new bytes[](2);
        s[0] = vm.addr(lo);
        s[1] = vm.addr(hi);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(lo, digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(hi, digest);
        g[0] = abi.encodePacked(r0, s0, v0);
        g[1] = abi.encodePacked(r1, s1, v1);
        book.fireByQuorum(q, keccak256("report"), dl, s, g);
    }

    function _world() internal returns (MockERC20 asset, RealVault rv, Whale whale, bytes32 d, bytes32 q) {
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
        d = book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2500, WINDOW, 0, 0));
        q = book.register(_detector(AlarmBook.Kind.QUORUM, address(rv), 2, 0, 0, 0));
        vm.prank(OWNER);
        rv.approve(address(router), type(uint256).max);
    }

    /// @dev Day 10: keep the DRAIN reference live, then the whale's two dips a minute apart fire the DRAIN part.
    function _whaleFiresDrainOnDay10(RealVault rv, Whale whale, bytes32 d) internal {
        vm.warp(block.timestamp + 8 days);
        book.checkpoint(d);
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(d);
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(d);
        whale.dip(book, rv, d, 400e18, true);
        vm.warp(block.timestamp + 60);
        assertTrue(whale.dip(book, rv, d, 400e18, true), "DRAIN fires on the whale's dips");
    }

    /// V3C-01, regression. A BOTH key with a DRAIN part must have a window of exactly one day (REFIRE_AFTER, the app
    /// preset's value). The 30-day key of the proof of concept, and any other window, is refused at arming.
    function test_V3C_01_longBothWindow_isRefusedAtArming() public {
        (,,, bytes32 d, bytes32 q) = _world();
        uint32[3] memory windows = [uint32(30 days), uint32(1 days + 1), uint32(7 days)];
        for (uint256 i; i < 3; ++i) {
            bytes32 both = book.register(_detector(AlarmBook.Kind.BOTH, address(0xB07), 0, windows[i], d, q));
            vm.prank(OWNER);
            vm.expectRevert(abi.encodeWithSelector(ExitRouter.DrainNeedsQuorum.selector, both));
            router.arm(_params(address(0xB07), 0, 0, _keys(both)));
        }
    }

    /// The proof of concept replayed with the allowed one-day key: the quorum signed on day 0, before the arming, has
    /// left the window by day 10, so the whale's dips fire only the DRAIN part and nobody is exited.
    function test_V3C_01_oneDayWindow_aQuorumFromDaysBeforeDoesntCount() public {
        (MockERC20 asset, RealVault rv, Whale whale, bytes32 d, bytes32 q) = _world();
        bytes32 both = book.register(_detector(AlarmBook.Kind.BOTH, address(rv), 0, 1 days, d, q));
        _fireQuorum(q); // day 0: the watchers sign once
        vm.warp(block.timestamp + 2 days);
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(rv), 0, 0, _keys(both))); // day 2: the app's shape arms
        _whaleFiresDrainOnDay10(rv, whale, d);
        assertTrue(!book.poke(both), "BOTH is silent: the only quorum is ten days old");
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, both, 0);
        assertEq(asset.balanceOf(OWNER), 0, "nothing was exited");
        assertEq(rv.balanceOf(OWNER), 600e18, "the owner keeps the position");
    }
}
