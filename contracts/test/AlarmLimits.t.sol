// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {Timelock} from "../src/Timelock.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {MockERC20, MockVault, MockOwned} from "./Mocks.sol";
import {RealVault} from "./AlarmAttacks.t.sol";

/// @dev Stands in for a large depositor who can move a vault's totalAssets inside one transaction.
contract Whale {
    function deposit(RealVault v, uint256 amt) external {
        MockERC20 a = v.assetToken();
        a.approve(address(v), amt);
        v.deposit(amt, address(this));
    }

    /// @dev Withdraw `shares`, let AlarmBook read the vault while it is lower, then deposit the same assets back.
    function dip(AlarmBook book, RealVault v, bytes32 key, uint256 shares, bool poke) external returns (bool fired) {
        MockERC20 a = v.assetToken();
        uint256 got = v.redeem(shares, address(this), address(this));
        if (poke) fired = book.poke(key);
        else book.checkpoint(key);
        a.approve(address(v), got);
        v.deposit(got, address(this));
    }
}

/// @dev Flash deposit that samples twice in one transaction, then pokes.
contract DoubleSampler {
    function run(AlarmBook book, RealVault v, bytes32 key, uint256 loan) external returns (bool fired) {
        v.assetToken().approve(address(v), loan);
        uint256 s = v.deposit(loan, address(this));
        book.checkpoint(key);
        book.checkpoint(key);
        v.redeem(s, address(this), address(this));
        fired = book.poke(key);
    }
}

/// @dev A smart-contract watcher (ERC-1271) that approves exactly one digest.
contract Wallet1271 {
    bytes32 public okHash;

    function set(bytes32 h) external {
        okHash = h;
    }

    function isValidSignature(bytes32 h, bytes memory) external view returns (bytes4) {
        return h == okHash ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract Reverter {
    fallback() external {
        revert();
    }
}

/// @notice The limits the two internal reviews found in AlarmBook and its interaction with ExitRouter (L-1, A2-01 to
/// A2-05). In v1 these tests pinned the documented behaviour; in v2 each one asserts the fix. The two behaviours v2 keeps
/// on purpose (A2-03's far-deadline signatures, and DRAIN's low-sample reference) stay pinned as documented limits.
contract AlarmLimitsTest is Base {
    uint256 internal constant PK_A = 0xA1;
    uint256 internal constant PK_B = 0xB2;
    uint32 internal constant WINDOW = 3600;
    bytes32 internal constant EVIDENCE = keccak256("report");
    address internal constant OWNER2 = address(0xCAFE02);

    function _initialWatchers() internal override returns (address[] memory) {
        return _addrs(vm.addr(PK_A), vm.addr(PK_B));
    }

    // ------------------------------------------------------------------ helpers

    function _armWith(address who, address target, bytes32 key) internal returns (bytes32 id) {
        vm.prank(who);
        MockERC20(target).approve(address(router), type(uint256).max);
        vm.prank(who);
        id = router.arm(_params(target, 0, 0, _keys(key)));
    }

    function _expectArmRefused(address who, address target, bytes32 key) internal {
        vm.prank(who);
        MockERC20(target).approve(address(router), type(uint256).max);
        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.AlarmNotClear.selector, key));
        router.arm(_params(target, 0, 0, _keys(key)));
    }

    function _sigsFor(bytes32 digest) internal returns (address[] memory s, bytes[] memory g) {
        (uint256 lo, uint256 hi) = vm.addr(PK_A) < vm.addr(PK_B) ? (PK_A, PK_B) : (PK_B, PK_A);
        s = new address[](2);
        g = new bytes[](2);
        s[0] = vm.addr(lo);
        s[1] = vm.addr(hi);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(lo, digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(hi, digest);
        g[0] = abi.encodePacked(r0, s0, v0);
        g[1] = abi.encodePacked(r1, s1, v1);
    }

    /// @dev Keeps a tripped key's episode going: a poke every day for `days_` days. Returns when the last fire was.
    function _refireDaily(bytes32 k, uint256 days_) internal returns (uint256 last) {
        for (uint256 i; i < days_; ++i) {
            vm.warp(block.timestamp + 1 days);
            assertTrue(book.poke(k), "refires daily while tripped");
        }
        last = block.timestamp;
    }

    function _episodeAt(bytes32 k) internal view returns (uint64 e) {
        (,,,,, e,) = book.state(k);
    }

    function _baseline(bytes32 k) internal view returns (uint256 b) {
        (,,, b,,,) = book.state(k);
    }

    // ------------------------------------------------------------------ L-1: arming on a live alarm is refused, not left waiting

    /// v1 (RefireGap PoC): a position armed one hour into a live alarm couldn't be exited by a keeper for 23 more hours.
    /// v2: the arming itself is refused with AlarmNotClear, so the app tells the owner to exit now instead.
    function test_armingOnALiveAlarmIsRefusedInsteadOfWaiting24h() public {
        _fireAlarm();
        vm.warp(block.timestamp + 1 hours);
        vault.deposit(OWNER, 100e18);
        _expectArmRefused(OWNER, address(vault), pauseKey);
        assertTrue(!book.armable(pauseKey), "not armable while live and tripped");
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(vault), 0, 0, new bytes32[](0))); // armed with no keys, the owner exits
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(stable.balanceOf(OWNER), 100e6, "exit now works");
    }

    /// Even a key that is clear again stays unarmable for REFIRE_AFTER after its last fire.
    function test_aKeyThatFiredInTheLastDayIsNotArmable_evenIfClearNow() public {
        _fireAlarm();
        pausable.setPaused(false);
        assertTrue(!book.armable(pauseKey), "fired just now");
        vm.warp(block.timestamp + 1 days - 1);
        assertTrue(!book.armable(pauseKey), "one second short of a day");
        vm.warp(block.timestamp + 1);
        assertTrue(book.armable(pauseKey), "a day after the fire, and clear");
    }

    // ------------------------------------------------------------------ A2-01: a tripped key can't be armed, and can be rebased

    /// v1: after a lasting loss the high-water mark never moved, the key refired daily, and whoever armed it later was
    /// exited at the next refire. v2: nobody can arm it while tripped, and after a week of refires anyone can rebase it.
    function test_shareDropKeyTrippedByALastingLossCantBeArmed_andRebasesAfterAWeek() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
        vault.setPrice(0.98e6); // a 2% loss that is never made good
        assertTrue(book.poke(k), "first fire");
        uint256 t0 = block.timestamp;
        assertEq(_episodeAt(k), t0, "episode begins at the first fire");

        vault.deposit(OWNER2, 100e18);
        vm.warp(t0 + 1 hours);
        _expectArmRefused(OWNER2, address(vault), k);

        vm.expectRevert(AlarmBook.EpisodeTooShort.selector);
        book.rebase(k);
        uint256 lastFire = _refireDaily(k, 6);
        assertEq(_episodeAt(k), t0, "refires inside the episode keep its start");
        vm.warp(t0 + 7 days - 1);
        vm.expectRevert(AlarmBook.EpisodeTooShort.selector);
        book.rebase(k);
        vm.warp(t0 + 7 days);

        vm.prank(ATTACKER); // anyone
        book.rebase(k);
        assertEq(_baseline(k), 0.98e6, "the mark is the current price");
        assertEq(_episodeAt(k), 0, "episode ended");
        assertTrue(!book.check(k), "no longer tripped");
        assertTrue(!book.armable(k), "but it fired less than a day ago");

        vm.warp(lastFire + 1 days);
        assertTrue(book.armable(k), "armable a day after the last fire");
        bytes32 id = _armWith(OWNER2, address(vault), k);
        assertTrue(!book.poke(k), "the old loss no longer fires");

        vault.setPrice(0.97e6); // a new 1% loss below the rebased mark
        assertTrue(book.poke(k), "a new loss fires");
        assertEq(_episodeAt(k), block.timestamp, "and starts a new episode");
        vm.prank(KEEPER);
        router.exit(id, k, 0);
        assertEq(stable.balanceOf(OWNER2), 97e6, "owner2 exited on the new loss only");
    }

    /// v1: one legitimate curator change tripped an ADDRESS_CHANGE key for good. v2: it can't be armed while tripped, and a
    /// week into the episode anyone can rebase it to the new curator.
    function test_addressChangeKeyRebasesToTheNewCuratorAfterAWeek() public {
        MockOwned owned = new MockOwned(address(0x111));
        bytes32 sel = bytes32(bytes4(keccak256("curator()")));
        bytes32 k = book.register(_detector(AlarmBook.Kind.ADDRESS_CHANGE, address(owned), 0, 0, sel, 0));
        owned.setCurator(address(0x222)); // an announced, harmless handover
        assertTrue(book.poke(k), "fires once");
        assertTrue(!book.armable(k), "tripped, so not armable");
        _refireDaily(k, 7);
        assertTrue(!book.armable(k), "still tripped a week later");
        book.rebase(k);
        assertEq(_baseline(k), uint256(uint160(address(0x222))), "the new curator is the baseline");
        vm.warp(block.timestamp + 1 days);
        assertTrue(book.armable(k), "clear again");
        owned.setCurator(address(0x333));
        assertTrue(book.check(k), "the next change trips it");
    }

    /// An episode ends when the key goes more than 2 * REFIRE_AFTER without a fire; the next fire starts a new one, so a
    /// key that only trips now and then can't be rebased on an old start date.
    function test_aGapOfMoreThanTwoDaysStartsANewEpisode() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
        vault.setPrice(0.98e6);
        assertTrue(book.poke(k), "fires");
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 2 days);
        assertTrue(book.poke(k), "a refire exactly 2 days later stays in the episode");
        assertEq(_episodeAt(k), t0, "same episode");
        vm.warp(block.timestamp + 2 days + 1);
        vm.expectRevert(AlarmBook.EpisodeTooShort.selector); // the episode lapsed, even though it began 4 days ago
        book.rebase(k);
        assertTrue(book.poke(k), "fires after the gap");
        assertEq(_episodeAt(k), block.timestamp, "a new episode");
        vm.warp(t0 + 30 days);
        vm.expectRevert(AlarmBook.EpisodeTooShort.selector); // no fire for weeks: no current episode
        book.rebase(k);
    }

    /// v1: the poisoned mark (AlarmAttacks test_poisonedShareMark_cantExitALaterUser) exited a later user at the first
    /// daily refire. v2: the poisoned key can't be armed, and a week of refires later anyone can rebase it away.
    function test_poisonedShareMarkCantBeArmed_andIsRebasedAway() public {
        MockERC20 asset = new MockERC20(18);
        RealVault rv = new RealVault(asset);
        asset.mint(ATTACKER, 2000e18);
        vm.startPrank(ATTACKER);
        asset.approve(address(rv), type(uint256).max);
        rv.deposit(1000e18, ATTACKER);
        asset.transfer(address(rv), 1000e18); // price 2
        vm.stopPrank();
        bytes32 key = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(rv), 50, 0, 0, 0));
        vm.prank(ATTACKER);
        rv.redeem(1000e18, ATTACKER, ATTACKER); // supply 0, price back to 1
        assertTrue(book.poke(key), "fires before anyone is armed");
        uint256 t0 = block.timestamp;

        vm.warp(t0 + 1 days);
        asset.mint(OWNER, 100e18);
        vm.startPrank(OWNER);
        asset.approve(address(rv), 100e18);
        rv.deposit(100e18, OWNER);
        vm.stopPrank();
        _expectArmRefused(OWNER, address(rv), key);

        _refireDaily(key, 7);
        book.rebase(key);
        assertEq(_baseline(key), 1e18, "the poison is gone");
        vm.warp(block.timestamp + 1 days);
        bytes32 id = _armWith(OWNER, address(rv), key);
        assertTrue(!book.poke(key), "no refire on the old poison");
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, key, 0);
    }

    function test_rebaseRefusesKindsThatClearOnTheirOwn() public {
        bytes32 qk = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xBEEF), 2, 0, 0, 0));
        bytes32 both = book.register(_detector(AlarmBook.Kind.BOTH, address(0), 0, 1 days, pauseKey, qk));
        _fireAlarm();
        vm.warp(block.timestamp + 8 days);
        bytes32[3] memory ks = [pauseKey, qk, both];
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert(AlarmBook.NotRebasable.selector);
            book.rebase(ks[i]);
        }
    }

    // ------------------------------------------------------------------ A2-02: DRAIN needs the drop seen twice, and windows of 1200 s or more

    function _drainWorld() internal returns (RealVault rv, Whale whale, bytes32 key, MockERC20 asset) {
        asset = new MockERC20(18);
        rv = new RealVault(asset);
        whale = new Whale();
        asset.mint(address(whale), 400e18);
        whale.deposit(rv, 400e18);
        asset.mint(address(this), 600e18);
        asset.approve(address(rv), 600e18);
        rv.deposit(600e18, address(this));
        key = book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2500, WINDOW, 0, 0));
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key); // first roll: reference 1000
    }

    function _pendingAt(bytes32 k) internal view returns (uint64 p) {
        (,,,,,, p) = book.state(k);
    }

    /// v1: a depositor holding 40% of the vault withdrew, poked and deposited back in one transaction, and the alarm fired
    /// with no loss. v2: that poke only starts a confirmation; the next poke, which finds the vault whole, cancels it.
    function test_drainIgnoresASingleLowReadingFromAFlashWithdrawal() public {
        (RealVault rv, Whale whale, bytes32 key, MockERC20 asset) = _drainWorld();
        rv.transfer(OWNER, 100e18);
        vm.prank(OWNER);
        rv.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(rv), 0, 0, _keys(key)));

        assertTrue(!whale.dip(book, rv, key, 400e18, true), "the dip doesn't fire");
        assertEq(_pendingAt(key), block.timestamp, "it only starts a confirmation");
        assertEq(rv.totalAssets(), 1000e18, "vault whole again");
        assertEq(asset.balanceOf(address(whale)), 0, "whale fully redeposited");
        assertTrue(!book.check(key), "nothing to do: the vault reads clear");

        vm.warp(block.timestamp + 60);
        assertTrue(!book.poke(key), "the confirming poke finds the vault whole");
        assertEq(_pendingAt(key), 0, "and cancels the confirmation");
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, key, 0);
    }

    /// A real drain still fires, a minute after it is first seen. A second poke inside the minute does nothing.
    function test_drainFiresWhenTheDropIsSeenTwiceAMinuteApart() public {
        (RealVault rv,, bytes32 key,) = _drainWorld();
        rv.exploitDrain(ATTACKER, 500e18);
        assertTrue(book.check(key), "a poke would start the confirmation");
        assertTrue(!book.poke(key), "first sight");
        assertTrue(!book.check(key), "pending, not yet confirmable");
        vm.warp(block.timestamp + 59);
        assertTrue(!book.check(key) && !book.poke(key), "59 s is too soon");
        vm.warp(block.timestamp + 1);
        assertTrue(book.check(key), "confirmable");
        assertTrue(book.poke(key), "fires");
        assertEq(_pendingAt(key), 0, "the confirmation is used up");
    }

    /// A confirmation older than the detector's window doesn't count: the next tripped poke starts a new one.
    function test_drainConfirmationLapsesAfterTheWindow() public {
        (RealVault rv, Whale whale, bytes32 key,) = _drainWorld();
        whale.dip(book, rv, key, 400e18, true);
        uint64 first = _pendingAt(key);
        assertTrue(first != 0, "pending");
        vm.warp(block.timestamp + WINDOW + 1); // nobody poked for longer than the window
        book.checkpoint(key); // a keeper's routine sample rolls the reference forward
        assertTrue(!whale.dip(book, rv, key, 400e18, true), "a second dip after the window only restarts it");
        assertTrue(_pendingAt(key) > first, "restarted");
    }

    /// The residual limit, pinned: a whale who dips twice, a minute apart, with nobody poking in between, still fires.
    /// The app offers DRAIN only inside BOTH with a watcher quorum, so this alone exits no one.
    function test_drainWhaleDippingTwiceAMinuteApartStillFires_documentedLimit() public {
        (RealVault rv, Whale whale, bytes32 key,) = _drainWorld();
        assertTrue(!whale.dip(book, rv, key, 400e18, true), "first dip: pending");
        vm.warp(block.timestamp + 60);
        assertTrue(whale.dip(book, rv, key, 400e18, true), "second dip: fires");
    }

    /// A depositor with 40% of the vault dips just under the threshold in two consecutive periods, sampling with
    /// checkpoint each time (the lowest sample of a period becomes the next reference, and a sample that would trip the
    /// alarm is refused). The reference falls to 60% of the real level, so a real 50% loss no longer fires. The control
    /// world, without the dips, fires. v2 keeps the period-low sampling, so this stays a documented limit.
    function test_drainReferenceFollowsLowSamplesSoALaterRealLossCanGoUnseen() public {
        bool blind;
        for (uint256 pass; pass < 2; ++pass) {
            (RealVault rv, Whale whale, bytes32 key,) = _drainWorld();
            if (pass == 0) {
                whale.dip(book, rv, key, 240e18, false); // 24% under the reference: not tripped, so it is sampled
                vm.warp(block.timestamp + WINDOW / 2);
                book.checkpoint(key); // roll: reference 760
                whale.dip(book, rv, key, 400e18, false); // 40% under the true level, 21% under the reference
                vm.warp(block.timestamp + WINDOW / 2);
                book.checkpoint(key); // roll: reference 600
            } else {
                vm.warp(block.timestamp + WINDOW);
                book.checkpoint(key);
            }
            rv.exploitDrain(ATTACKER, 500e18); // a real 50% loss
            bool tripped = book.check(key);
            if (pass == 0) blind = !tripped;
            else assertTrue(tripped, "control: without the dips the 50% loss fires");
        }
        assertTrue(blind, "with two low readings the same 50% loss does not fire");
    }

    /// v1 accepted DRAIN windows of 1 or 2 seconds, so two samples inside one flash deposit became the reference.
    /// v2 refuses windows under MIN_DRAIN_WINDOW, and at the minimum the same double sample can't fire.
    function test_drainWindowsUnder1200sAreRefused_andTwoSamplesInOneFlashCantFire() public {
        MockERC20 asset = new MockERC20(18);
        RealVault rv = new RealVault(asset);
        asset.mint(address(this), 1000e18);
        asset.approve(address(rv), 1000e18);
        rv.deposit(1000e18, address(this));
        uint32[3] memory bad = [uint32(1), uint32(2), uint32(1199)];
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert(AlarmBook.BadDetector.selector);
            book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2500, bad[i], 0, 0));
        }
        bytes32 key = book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2500, 1200, 0, 0));
        vm.warp(block.timestamp + 600);
        DoubleSampler s = new DoubleSampler();
        asset.mint(address(s), 334e18);
        assertTrue(!s.run(book, rv, key, 334e18), "the flash deposit can't fire it");
        assertEq(_pendingAt(key), 0, "nor start a confirmation");
        vm.warp(block.timestamp + 60);
        assertTrue(!book.check(key) && !book.poke(key), "and nothing fires later");
    }

    // ------------------------------------------------------------------ A2-03: QUORUM signatures with a far deadline (kept)

    /// The 1-hour cap is measured at fire time, not at signing time. Signatures made with a 30-day deadline can't fire
    /// for 30 days minus an hour, then anyone holding them can fire in the last hour. Watchers cap their own deadlines.
    function test_farDeadlineQuorumSignatureCanFireByAnyoneInItsLastHour() public {
        bytes32 qk = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xBEEF), 2, 0, 0, 0));
        uint64 dl = uint64(block.timestamp + 30 days);
        (address[] memory s, bytes[] memory g) = _sigsFor(book.attestDigest(qk, EVIDENCE, dl));

        vm.expectRevert(AlarmBook.DeadlineTooFar.selector);
        book.fireByQuorum(qk, EVIDENCE, dl, s, g);

        vm.warp(dl - 1 hours - 1);
        vm.expectRevert(AlarmBook.DeadlineTooFar.selector);
        book.fireByQuorum(qk, EVIDENCE, dl, s, g);

        vm.warp(dl - 1 hours);
        vm.prank(ATTACKER); // any holder of the signatures, 30 days after the watchers signed
        book.fireByQuorum(qk, EVIDENCE, dl, s, g);
        assertTrue(book.isLive(qk, 1 days), "fired from month-old signatures");
    }

    // ------------------------------------------------------------------ A2-04: watcher approvals wait and expire

    /// v1: the AlarmBook admin could approve watchers at any time, with immediate effect and no end. v2: a new watcher can
    /// sign only two days after approval, which gives holders of QUORUM keys time to disarm, and approvals end.
    function test_newWatchersWaitTwoDays_evenAfterTheRouterAdminExpired() public {
        address proposer = address(0x9999);
        Timelock tl = new Timelock(proposer, 0); // the live setup: delay 0
        AlarmBook b2 = new AlarmBook(address(tl), new address[](0));
        uint256 expiry = block.timestamp + 365 days;
        ERC4626Adapter a2 = new ERC4626Adapter(vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1));
        address[] memory adapters = new address[](1);
        adapters[0] = address(a2);
        ExitRouter r2 = new ExitRouter(
            address(stable), address(weth), address(swap), address(b2), address(tl), GUARD, address(stableFeed), 90_000,
            expiry, adapters
        );
        assertTrue(a2.ROUTER() == address(r2) && r2.adapterAllowed(address(a2)), "adapter allowed in the constructor");

        bytes32 qk = b2.register(_detector(AlarmBook.Kind.QUORUM, address(vault), 2, 0, 0, 0));
        vault.deposit(OWNER, 100e18);
        vm.prank(OWNER);
        vault.approve(address(r2), type(uint256).max);
        ExitRouter.ArmParams memory p = _params(address(vault), 0, 0, _keys(qk));
        p.adapter = address(a2);
        vm.prank(OWNER);
        bytes32 id = r2.arm(p);

        // After the router's admin expires the router can't be touched, but the watcher list still can, with a delay.
        vm.warp(expiry + 1);
        _execExpectFail(tl, proposer, address(r2), abi.encodeCall(ExitRouter.setAdapter, (address(a2), false)));
        uint64 until = uint64(block.timestamp + 365 days);
        _exec(tl, proposer, address(b2), abi.encodeCall(AlarmBook.setWatcher, (vm.addr(PK_A), until)));
        _exec(tl, proposer, address(b2), abi.encodeCall(AlarmBook.setWatcher, (vm.addr(PK_B), until)));
        assertTrue(!b2.isWatcher(vm.addr(PK_A)), "not active yet");

        uint64 dl = uint64(block.timestamp + 600);
        (address[] memory s, bytes[] memory g) = _sigsFor(b2.attestDigest(qk, EVIDENCE, dl));
        vm.expectRevert(abi.encodeWithSelector(AlarmBook.NotWatcher.selector, s[0]));
        b2.fireByQuorum(qk, EVIDENCE, dl, s, g);

        // The two days are the owner's window to leave the key.
        vm.warp(block.timestamp + 2 days - 1);
        assertTrue(!b2.isWatcher(vm.addr(PK_A)), "one second short");
        vm.prank(OWNER);
        r2.disarm(id);
        vm.warp(block.timestamp + 1);
        dl = uint64(block.timestamp + 600);
        (s, g) = _sigsFor(b2.attestDigest(qk, EVIDENCE, dl));
        b2.fireByQuorum(qk, EVIDENCE, dl, s, g);
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotArmed.selector);
        r2.exit(id, qk, 0);
    }

    /// The constructor's watchers are active at once for a year, then lapse unless the admin extends them first. Extending an
    /// active watcher takes effect at once; re-approving a lapsed one waits the two days again.
    function test_watcherApprovalsExpire_andExtendingAnActiveOneIsImmediate() public {
        address wA = vm.addr(PK_A);
        bytes32 qk = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xBEEF), 2, 0, 0, 0));
        assertTrue(book.isWatcher(wA), "active from deployment");
        assertEq(book.watcherUntil(wA), block.timestamp + 365 days, "for a year");

        vm.warp(block.timestamp + 300 days);
        vm.prank(ADMIN);
        book.setWatcher(wA, uint64(block.timestamp + 365 days));
        assertTrue(book.isWatcher(wA), "extended with no gap");

        vm.warp(block.timestamp + 65 days); // the other watcher's year is over
        assertTrue(!book.isWatcher(vm.addr(PK_B)), "lapsed");
        uint64 dl = uint64(block.timestamp + 600);
        (address[] memory s, bytes[] memory g) = _sigsFor(book.attestDigest(qk, EVIDENCE, dl));
        vm.expectRevert(abi.encodeWithSelector(AlarmBook.NotWatcher.selector, vm.addr(PK_B)));
        book.fireByQuorum(qk, EVIDENCE, dl, s, g);

        vm.prank(ADMIN);
        book.setWatcher(vm.addr(PK_B), uint64(block.timestamp + 30 days));
        assertTrue(!book.isWatcher(vm.addr(PK_B)), "a lapsed watcher waits again");
        vm.warp(block.timestamp + 2 days);
        dl = uint64(block.timestamp + 600);
        (s, g) = _sigsFor(book.attestDigest(qk, EVIDENCE, dl));
        book.fireByQuorum(qk, EVIDENCE, dl, s, g);
        assertTrue(book.isLive(qk, 0), "fired");
    }

    function _exec(Timelock tl, address proposer, address target, bytes memory data) internal {
        vm.startPrank(proposer);
        tl.schedule(target, 0, data, bytes32(0));
        tl.execute(target, 0, data, bytes32(0));
        vm.stopPrank();
    }

    function _execExpectFail(Timelock tl, address proposer, address target, bytes memory data) internal {
        bytes32 salt = bytes32(uint256(1));
        vm.startPrank(proposer);
        tl.schedule(target, 0, data, salt);
        vm.expectRevert(abi.encodeWithSelector(Timelock.CallFailed.selector, abi.encodeWithSelector(ExitRouter.NotAdmin.selector)));
        tl.execute(target, 0, data, salt);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ A2-05: "at or after the arming", exactly

    /// A fire in the same second as the arming, after it, authorizes a keeper.
    function test_alarmFiredInTheSameSecondAsArmingAuthorizesAKeeper() public {
        vault.deposit(OWNER, 100e18);
        vm.prank(OWNER);
        vault.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(vault), 0, 0, _keys(pauseKey)));
        pausable.setPaused(true);
        assertTrue(book.poke(pauseKey), "fires in the arming's second");
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(stable.balanceOf(OWNER), 100e6, "exited");
    }

    /// A fire before the arming, even in the same second, can't authorize anyone: the arming itself is refused.
    function test_alarmFiredBeforeArmingInTheSameSecondIsRefusedAtArming() public {
        vault.deposit(OWNER, 100e18);
        pausable.setPaused(true);
        assertTrue(book.poke(pauseKey), "fires");
        _expectArmRefused(OWNER, address(vault), pauseKey);
        vm.warp(block.timestamp + 1);
        _expectArmRefused(OWNER, address(vault), pauseKey);
    }

    // ------------------------------------------------------------------ checks that pass (coverage gaps in the suite)

    /// The live-path of ERC-1271 (a contract watcher that approves).
    function test_contractWatcherThatApprovesCanSignViaErc1271() public {
        Wallet1271 w = new Wallet1271();
        _approveWatcher(address(w));
        vm.warp(block.timestamp + 2 days);
        bytes32 qk = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xBEEF), 2, 0, 0, 0));
        uint64 dl = uint64(block.timestamp + 600);
        bytes32 digest = book.attestDigest(qk, EVIDENCE, dl);
        w.set(digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK_A, digest);
        address[] memory sg = new address[](2);
        bytes[] memory gs = new bytes[](2);
        bool wFirst = address(w) < vm.addr(PK_A);
        sg[0] = wFirst ? address(w) : vm.addr(PK_A);
        sg[1] = wFirst ? vm.addr(PK_A) : address(w);
        gs[wFirst ? 0 : 1] = hex"1234"; // the wallet ignores the bytes
        gs[wFirst ? 1 : 0] = abi.encodePacked(r, s, v);
        book.fireByQuorum(qk, EVIDENCE, dl, sg, gs);
        assertTrue(book.isLive(qk, 1), "fired with an ERC-1271 signer");
    }

    /// An EOA that has gained code (EIP-7702) still signs by plain ECDSA when its ERC-1271 call fails.
    function test_eoaWithCodeFallsBackToEcdsa() public {
        address a = vm.addr(PK_A);
        vm.etch(a, address(new Reverter()).code);
        bytes32 qk = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xBEEF), 2, 0, 0, 0));
        uint64 dl = uint64(block.timestamp + 600);
        (address[] memory s, bytes[] memory g) = _sigsFor(book.attestDigest(qk, EVIDENCE, dl));
        book.fireByQuorum(qk, EVIDENCE, dl, s, g);
        assertTrue(book.isLive(qk, 1), "fired");
    }

    /// A signature made for another deployment is no good: the domain separator binds the contract and the chain id.
    function test_signatureForAnotherDeploymentIsRejected() public {
        AlarmBook other = new AlarmBook(ADMIN, new address[](0));
        bytes32 qk = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xBEEF), 2, 0, 0, 0));
        uint64 dl = uint64(block.timestamp + 600);
        (address[] memory s, bytes[] memory g) = _sigsFor(other.attestDigest(qk, EVIDENCE, dl));
        vm.expectRevert(abi.encodeWithSelector(AlarmBook.BadSignature.selector, s[0]));
        book.fireByQuorum(qk, EVIDENCE, dl, s, g);
    }

    /// The EIP-712 domain: name, version "2", the chain id and the contract.
    function test_domainSeparatorBindsTheChainIdAndTheContract() public {
        bytes32 typeHash = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 name = keccak256("Canopy AlarmBook");
        bytes32 version = keccak256("2");
        assertTrue(
            book.DOMAIN_SEPARATOR() == keccak256(abi.encode(typeHash, name, version, block.chainid, address(book))),
            "domain for this chain"
        );
        vm.chainId(4663);
        AlarmBook live = new AlarmBook(ADMIN, new address[](0));
        assertTrue(
            live.DOMAIN_SEPARATOR() == keccak256(abi.encode(typeHash, name, version, uint256(4663), address(live))),
            "domain for Robinhood Chain"
        );
        assertTrue(live.DOMAIN_SEPARATOR() != book.DOMAIN_SEPARATOR(), "differs from the test chain");
    }
}
