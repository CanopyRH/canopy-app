// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {Timelock} from "../src/Timelock.sol";
import {MockERC20, MockVault, MockFeed, MockPausable, MockOwned} from "./Mocks.sol";

contract AlarmBookTest is Base {
    uint256 internal constant PK_A = 0xA1;
    uint256 internal constant PK_B = 0xB2;
    uint256 internal constant PK_C = 0xC3;
    address internal wA;
    address internal wB;
    address internal wC;
    bytes32 internal quorumKey;
    bytes32 internal constant EVIDENCE = keccak256("evidence");

    function _initialWatchers() internal override returns (address[] memory) {
        return _addrs(vm.addr(PK_A), vm.addr(PK_B), vm.addr(PK_C));
    }

    function setUp() public override {
        super.setUp();
        wA = vm.addr(PK_A);
        wB = vm.addr(PK_B);
        wC = vm.addr(PK_C);
        quorumKey = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xBEEF), 2, 0, 0, 0));
    }

    // ---------------------------------------------------------------- on-chain kinds

    function test_priceBelow() public {
        MockFeed f = new MockFeed(1e8);
        bytes32 k = book.register(_detector(AlarmBook.Kind.PRICE_BELOW, address(f), 0.97e8, 3600, 0, 0));
        assertTrue(!book.check(k), "healthy");
        f.set(0.96e8, block.timestamp);
        assertTrue(book.poke(k), "fired");
    }

    function test_priceBelow_ignoresStaleAnswer() public {
        MockFeed f = new MockFeed(1e8);
        bytes32 k = book.register(_detector(AlarmBook.Kind.PRICE_BELOW, address(f), 0.97e8, 3600, 0, 0));
        f.set(0.96e8, block.timestamp - 3601);
        assertTrue(!book.check(k), "stale does not fire");
    }

    function test_shareDrop_andHighWaterMark() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
        vault.setPrice(1.1e6);
        book.checkpoint(k);
        vault.setPrice(1.0950e6); // 0.45% below the new mark
        assertTrue(!book.check(k), "inside threshold");
        vault.setPrice(1.09e6);
        assertTrue(book.poke(k), "fired against the raised mark");
    }

    function test_shareDrop_markNeverFalls() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
        vault.setPrice(0.9e6);
        book.checkpoint(k);
        assertTrue(book.check(k), "cannot be reset away");
    }

    function test_shareDrop_smallDipDoesNotLowerMark() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
        vault.setPrice(0.999e6); // 0.1% down: not tripped, so checkpoint runs
        book.checkpoint(k);
        vault.setPrice(0.9945e6); // 0.55% below the original mark, only 0.45% below a lowered one
        assertTrue(book.check(k), "measured against the original mark");
    }

    function test_drain_snapshotCannotResetAfterWindowWhileTripped() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.DRAIN, address(vault), 2500, 3600, 0, 0));
        vm.warp(block.timestamp + 1800); // past window/2, so only the tripped check protects it
        vault.setPrice(0.74e6);
        book.checkpoint(k);
        assertTrue(book.check(k), "a drain cannot be reset away");
    }

    function test_paused() public {
        assertTrue(!book.check(pauseKey), "not paused");
        pausable.setPaused(true);
        assertTrue(book.poke(pauseKey), "fired");
    }

    function test_addressChange() public {
        MockOwned o = new MockOwned(OWNER);
        bytes32 k = book.register(
            _detector(AlarmBook.Kind.ADDRESS_CHANGE, address(o), 0, 0, bytes32(bytes4(keccak256("curator()"))), 0)
        );
        assertTrue(!book.check(k), "unchanged");
        o.setCurator(KEEPER);
        assertTrue(book.poke(k), "fired");
    }

    function test_drain_andCheckpointRules() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.DRAIN, address(vault), 2500, 3600, 0, 0));
        vault.setPrice(0.74e6); // totalAssets down 26%
        assertTrue(!book.check(k), "a new detector has no confirmed baseline yet");
        vault.setPrice(1e6);
        vm.warp(block.timestamp + 1800);
        book.checkpoint(k); // the first period's low becomes the baseline
        vault.setPrice(0.74e6);
        assertTrue(book.check(k), "tripped");
        vm.warp(block.timestamp + 1800);
        book.checkpoint(k);
        assertTrue(book.check(k), "snapshot does not refresh while tripped");
        assertTrue(!book.poke(k), "the first tripped poke only starts the confirmation");
        vm.warp(block.timestamp + 60);
        assertTrue(book.poke(k), "fired when seen again a minute later");
    }

    function test_drain_snapshotExpires() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.DRAIN, address(vault), 2500, 3600, 0, 0));
        vm.warp(block.timestamp + 1800);
        book.checkpoint(k);
        vm.warp(block.timestamp + 3601);
        vault.setPrice(0.5e6);
        assertTrue(!book.check(k), "old snapshot does not count");
    }

    function test_both_needsBothInsideWindow() public {
        MockPausable p2 = new MockPausable();
        bytes32 k2 = book.register(_detector(AlarmBook.Kind.PAUSED, address(p2), 0, 0, 0, 0));
        bytes32 both = book.register(_detector(AlarmBook.Kind.BOTH, address(0), 0, 1 days, pauseKey, k2));
        pausable.setPaused(true);
        book.poke(pauseKey);
        assertTrue(!book.check(both), "one is not enough");
        vm.warp(block.timestamp + 1 days + 1);
        p2.setPaused(true);
        book.poke(k2);
        assertTrue(!book.check(both), "too far apart");
        assertTrue(book.poke(pauseKey), "the first part can refire");
        assertTrue(book.poke(both), "fired");
    }

    function test_both_windowCantBeShorterThanTheRefireDelay() public {
        MockPausable p2 = new MockPausable();
        bytes32 k2 = book.register(_detector(AlarmBook.Kind.PAUSED, address(p2), 0, 0, 0, 0));
        vm.expectRevert(AlarmBook.BadDetector.selector);
        book.register(_detector(AlarmBook.Kind.BOTH, address(0), 0, 1 days - 1, pauseKey, k2));
    }

    function test_refireAfter24h() public {
        pausable.setPaused(true);
        assertTrue(book.poke(pauseKey), "first");
        assertTrue(!book.poke(pauseKey), "no double fire");
        vm.warp(block.timestamp + 1 days);
        assertTrue(book.poke(pauseKey), "refire");
    }

    function test_register_isIdempotentAndValidates() public {
        assertTrue(book.register(_detector(AlarmBook.Kind.PAUSED, address(pausable), 0, 0, 0, 0)) == pauseKey, "same key");
        vm.expectRevert(AlarmBook.BadDetector.selector);
        book.register(_detector(AlarmBook.Kind.QUORUM, address(1), 1, 0, 0, 0));
    }

    // ---------------------------------------------------------------- quorum

    function _sig(uint256 pk, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sorted2(uint256 p1, uint256 p2, bytes32 digest)
        internal
        returns (address[] memory s, bytes[] memory g)
    {
        (address a1, address a2) = (vm.addr(p1), vm.addr(p2));
        s = new address[](2);
        g = new bytes[](2);
        (uint256 lo, uint256 hi) = a1 < a2 ? (p1, p2) : (p2, p1);
        s[0] = vm.addr(lo);
        s[1] = vm.addr(hi);
        g[0] = _sig(lo, digest);
        g[1] = _sig(hi, digest);
    }

    function test_quorum_twoOfThreeFires() public {
        uint64 dl = uint64(block.timestamp + 600);
        (address[] memory s, bytes[] memory g) = _sorted2(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
        assertTrue(book.isLive(quorumKey, 1 days), "live");
        assertTrue(book.signersOf(quorumKey).length == 2, "signers recorded");
    }

    function test_quorum_oneSignerFails() public {
        uint64 dl = uint64(block.timestamp + 600);
        address[] memory s = new address[](1);
        bytes[] memory g = new bytes[](1);
        s[0] = wA;
        g[0] = _sig(PK_A, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.expectRevert(AlarmBook.BadSigners.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_quorum_duplicateAndUnsortedFail() public {
        uint64 dl = uint64(block.timestamp + 600);
        bytes32 d = book.attestDigest(quorumKey, EVIDENCE, dl);
        address[] memory s = new address[](2);
        bytes[] memory g = new bytes[](2);
        s[0] = wA;
        s[1] = wA;
        g[0] = _sig(PK_A, d);
        g[1] = _sig(PK_A, d);
        vm.expectRevert(AlarmBook.BadSigners.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
        (address[] memory s2, bytes[] memory g2) = _sorted2(PK_A, PK_B, d);
        (s2[0], s2[1]) = (s2[1], s2[0]);
        (g2[0], g2[1]) = (g2[1], g2[0]);
        vm.expectRevert(AlarmBook.BadSigners.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s2, g2);
    }

    function test_quorum_nonWatcherFails() public {
        uint64 dl = uint64(block.timestamp + 600);
        uint256 pkOutsider = 0xD4;
        bytes32 d = book.attestDigest(quorumKey, EVIDENCE, dl);
        (address[] memory s, bytes[] memory g) = _sorted2(PK_A, pkOutsider, d);
        vm.expectRevert(abi.encodeWithSelector(AlarmBook.NotWatcher.selector, vm.addr(pkOutsider)));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_quorum_removedWatcherFails() public {
        vm.prank(ADMIN);
        book.setWatcher(wB, 0);
        uint64 dl = uint64(block.timestamp + 600);
        bytes32 d = book.attestDigest(quorumKey, EVIDENCE, dl);
        (address[] memory s, bytes[] memory g) = _sorted2(PK_A, PK_B, d);
        vm.expectRevert(abi.encodeWithSelector(AlarmBook.NotWatcher.selector, wB));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_quorum_expiredFails() public {
        uint64 dl = uint64(block.timestamp + 600);
        (address[] memory s, bytes[] memory g) = _sorted2(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.warp(block.timestamp + 601);
        vm.expectRevert(AlarmBook.Expired.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_quorum_badSignatureFails() public {
        uint64 dl = uint64(block.timestamp + 600);
        (address[] memory s, bytes[] memory g) = _sorted2(PK_A, PK_B, keccak256("wrong digest"));
        vm.expectRevert();
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_quorum_cannotFireAnotherKey() public {
        bytes32 other = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xCAFE), 2, 0, 0, 0));
        uint64 dl = uint64(block.timestamp + 600);
        (address[] memory s, bytes[] memory g) = _sorted2(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.expectRevert();
        book.fireByQuorum(other, EVIDENCE, dl, s, g);
    }

    function test_quorum_pokeNeverFires() public {
        assertTrue(!book.poke(quorumKey), "only signatures fire it");
    }

    function test_setWatcher_onlyAdmin() public {
        vm.prank(ATTACKER);
        vm.expectRevert(AlarmBook.NotAdmin.selector);
        book.setWatcher(ATTACKER, uint64(block.timestamp + 1 days));
    }

    function test_quorumAlarm_endToEndExit() public {
        bytes32 id;
        vault.deposit(OWNER, 100e18);
        vm.prank(OWNER);
        vault.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        id = router.arm(_params(address(vault), 0, 0, _keys(quorumKey)));
        uint64 dl = uint64(block.timestamp + 600);
        (address[] memory s, bytes[] memory g) = _sorted2(PK_B, PK_C, book.attestDigest(quorumKey, EVIDENCE, dl));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
        vm.prank(KEEPER);
        router.exit(id, quorumKey, 0);
        assertEq(stable.balanceOf(OWNER), 100e6, "owner paid");
    }
}

contract TimelockTest is Base {
    Timelock internal lock;
    ExitRouter internal locked;

    function setUp() public override {
        super.setUp();
        lock = new Timelock(ADMIN, 48 hours);
        locked = new ExitRouter(
            address(stable), address(weth), address(swap), address(book), address(lock), GUARD,
            address(stableFeed), 90_000, block.timestamp + EXPIRY_FROM_START, new address[](0)
        );
    }

    function _data() internal pure returns (bytes memory) {
        return abi.encodeCall(ExitRouter.setAdapter, (address(0x1234), true));
    }

    function test_delayCeiling() public {
        vm.expectRevert(Timelock.DelayTooLong.selector);
        new Timelock(ADMIN, 30 days + 1);
    }

    /// @dev With no delay, one multisig batch schedules and executes in the same transaction.
    function test_zeroDelayAppliesInOneBatch() public {
        Timelock now0 = new Timelock(ADMIN, 0);
        ExitRouter r = new ExitRouter(
            address(stable), address(weth), address(swap), address(book), address(now0), GUARD,
            address(stableFeed), 90_000, block.timestamp + EXPIRY_FROM_START, new address[](0)
        );
        vm.prank(ADMIN);
        now0.schedule(address(r), 0, _data(), 0);
        vm.prank(ADMIN);
        now0.execute(address(r), 0, _data(), 0);
        assertTrue(r.adapterAllowed(address(0x1234)), "applied at once");
        vm.prank(ATTACKER);
        vm.expectRevert(Timelock.NotProposer.selector);
        now0.schedule(address(r), 0, _data(), bytes32(uint256(1)));
    }

    function test_noChangeBefore48h() public {
        vm.prank(ADMIN);
        lock.schedule(address(locked), 0, _data(), 0);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.prank(ADMIN);
        vm.expectRevert(Timelock.NotReady.selector);
        lock.execute(address(locked), 0, _data(), 0);
    }

    function test_changeAfter48h() public {
        vm.prank(ADMIN);
        lock.schedule(address(locked), 0, _data(), 0);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(ADMIN);
        lock.execute(address(locked), 0, _data(), 0);
        assertTrue(locked.adapterAllowed(address(0x1234)), "applied");
    }

    function test_aScheduledChangeLapses() public {
        vm.prank(ADMIN);
        lock.schedule(address(locked), 0, _data(), 0);
        vm.warp(block.timestamp + 48 hours + 14 days + 1);
        vm.prank(ADMIN);
        vm.expectRevert(Timelock.Lapsed.selector);
        lock.execute(address(locked), 0, _data(), 0);
    }

    function test_onlyProposer() public {
        vm.prank(ATTACKER);
        vm.expectRevert(Timelock.NotProposer.selector);
        lock.schedule(address(locked), 0, _data(), 0);
    }

    function test_cancel() public {
        vm.prank(ADMIN);
        bytes32 id = lock.schedule(address(locked), 0, _data(), 0);
        vm.prank(ADMIN);
        lock.cancel(id);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(ADMIN);
        vm.expectRevert(Timelock.NotReady.selector);
        lock.execute(address(locked), 0, _data(), 0);
    }
}
