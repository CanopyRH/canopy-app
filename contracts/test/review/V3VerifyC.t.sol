// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.sol";
import {AlarmBook} from "../../src/AlarmBook.sol";
import {ExitRouter} from "../../src/ExitRouter.sol";
import {MockERC20} from "../Mocks.sol";
import {RealVault} from "../AlarmAttacks.t.sol";
import {Whale} from "../AlarmLimits.t.sol";

/// @notice Verification of the BOTH-part checks (V3B-01 fix), review on verify-v3c.
///
/// V3C-01 (Info, docs). The fix is complete for structure: a DRAIN reaches an exit only through BOTH(DRAIN, QUORUM).
/// But a BOTH key's window has only a lower bound (REFIRE_AFTER), and the owner picks it. SECURITY.md says a DRAIN fire
/// exits someone "only if two active watchers also signed within the BOTH key's 24 hours"; with a 30-day BOTH key, a
/// quorum signed 10 days earlier (before the arming, even) plus a whale's two dips today exits the owner. The app's
/// preset uses 1 day, so this needs an owner who registers a long window.
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

    function test_V3C_01_longBothWindow_quorumFromDaysBeforeArmingPlusAWhaleDipExits() public {
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
        bytes32 d = book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2500, WINDOW, 0, 0));
        bytes32 q = book.register(_detector(AlarmBook.Kind.QUORUM, address(rv), 2, 0, 0, 0));
        bytes32 both = book.register(_detector(AlarmBook.Kind.BOTH, address(rv), 0, 30 days, d, q));

        _fireQuorum(q); // day 0: the watchers sign once
        vm.warp(block.timestamp + 2 days);
        vm.prank(OWNER);
        rv.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(rv), 0, 0, _keys(both))); // day 2: accepted, BOTH(DRAIN, QUORUM)

        vm.warp(block.timestamp + 8 days); // day 10: keep the DRAIN reference live
        book.checkpoint(d);
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(d);
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(d);
        whale.dip(book, rv, d, 400e18, true);
        vm.warp(block.timestamp + 60);
        assertTrue(whale.dip(book, rv, d, 400e18, true), "DRAIN fires on the whale's dips");
        assertTrue(book.poke(both), "BOTH fires on a quorum signed ten days ago, before the arming");
        vm.prank(KEEPER);
        router.exit(id, both, 0);
        assertEq(asset.balanceOf(OWNER), 600e18, "exited, with no watcher signature in the last 24 hours");
    }
}
