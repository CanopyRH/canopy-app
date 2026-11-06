// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.sol";
import {AlarmBook} from "../../src/AlarmBook.sol";
import {ExitRouter} from "../../src/ExitRouter.sol";
import {MockERC20} from "../Mocks.sol";
import {RealVault, FlashAttacker} from "../AlarmAttacks.t.sol";

/// @notice V3-01, regression. In v2 as reviewed, a DRAIN reference could be one flash-inflated reading: the candidate set
/// by a roll is the only sample of its period unless someone else checkpoints before the next roll, and once the key
/// read tripped `checkpoint` returned early, so an attacker with a flash loan (no capital, no shares) fired DRAIN on a
/// vault that lost nothing. Fixed: alarms measure against the lower of the last two period lows (`snap`, `prevSnap`), so
/// a single inflated period never trips the key; it takes two consecutive periods with no honest sample.
contract V3DrainTest is Base {
    uint32 internal constant WINDOW = 3600; // the app's preset
    uint256 internal constant LOAN = 500e18;

    MockERC20 internal asset;
    RealVault internal rv;
    FlashAttacker internal fa;
    bytes32 internal key;
    bytes32 internal posId;
    bytes32 internal quorum;
    bytes32 internal both; // the app's "Vault drain + confirmation": DRAIN and a QUORUM key within a day
    uint256 internal constant PK_A = 0xA1;
    uint256 internal constant PK_B = 0xB2;

    function _initialWatchers() internal override returns (address[] memory) {
        return _addrs(vm.addr(PK_A), vm.addr(PK_B));
    }

    function _fireQuorum() internal {
        uint64 dl = uint64(block.timestamp + 600);
        bytes32 digest = book.attestDigest(quorum, keccak256("report"), dl);
        (uint256 lo, uint256 hi) = vm.addr(PK_A) < vm.addr(PK_B) ? (PK_A, PK_B) : (PK_B, PK_A);
        address[] memory s = _addrs(vm.addr(lo), vm.addr(hi));
        bytes[] memory g = new bytes[](2);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(lo, digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(hi, digest);
        g[0] = abi.encodePacked(r0, s0, v0);
        g[1] = abi.encodePacked(r1, s1, v1);
        book.fireByQuorum(quorum, keccak256("report"), dl, s, g);
    }

    function setUp() public override {
        super.setUp();
        asset = new MockERC20(18);
        rv = new RealVault(asset);
        fa = new FlashAttacker();
        asset.mint(OWNER, 1000e18);
        vm.prank(OWNER);
        asset.approve(address(rv), 1000e18);
        vm.prank(OWNER);
        rv.deposit(1000e18, OWNER);
        key = book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2500, WINDOW, 0, 0));
        // An honest first period: the reference is the real 1000.
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key);
        (,,,, uint256 snap,,,) = book.state(key);
        assertEq(snap, 1000e18, "honest first period low (the reference goes live at the next roll)");
        quorum = book.register(_detector(AlarmBook.Kind.QUORUM, address(rv), 2, 0, 0, 0));
        both = book.register(_detector(AlarmBook.Kind.BOTH, address(rv), 0, 1 days, key, quorum));
        vm.prank(OWNER);
        rv.approve(address(router), type(uint256).max);
        // A bare DRAIN key can't be armed (V3V-01); the owner arms it the only way it can be, inside BOTH.
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.DrainNeedsQuorum.selector, key));
        router.arm(_params(address(rv), 0, 0, _keys(key)));
        vm.prank(OWNER);
        posId = router.arm(_params(address(rv), 0, 0, _keys(both)));
    }

    function _flashRoll() internal {
        vm.warp(block.timestamp + WINDOW / 2);
        asset.mint(address(fa), LOAN);
        fa.flash(book, rv, key, LOAN);
        (,,, uint256 cand,,,,) = book.state(key);
        assertEq(cand, 1500e18, "the flash reading is the candidate");
    }

    function _snaps() internal view returns (uint256 snap, uint256 prevSnap) {
        (,,,, snap,,, prevSnap) = book.state(key);
    }

    /// v2 (the review's PoC): one flash-inflated sample in an unsampled period became the whole reference, and a flash loan
    /// fired DRAIN on a vault that lost nothing. Fixed: the reference is the lower of the last two period lows, so the
    /// inflated period is measured against the honest one before it and nothing trips. And because the key reads clear,
    /// an honest sample can still pull the next candidate down.
    function test_V3_01_oneFlashPeriodCantFire() public {
        _flashRoll();
        // Nobody samples during this period. At its end anyone rolls (plain checkpoint, no flash needed).
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key);
        (uint256 snap, uint256 prevSnap) = _snaps();
        assertEq(snap, 1500e18, "the flash reading is that period's low");
        assertEq(prevSnap, 1000e18, "but the period before it was honest");
        assertEq(rv.totalAssets(), 1000e18, "the vault lost nothing");
        assertTrue(!book.check(key), "measured against min(1500, 1000): not tripped");

        // Honest samples still count: the key reads clear, so checkpoint keeps working.
        book.checkpoint(key);
        (,,, uint256 cand,,,,) = book.state(key);
        assertEq(cand, 1000e18, "an honest sample pulls the next candidate back down");

        assertTrue(!book.poke(key), "no sighting");
        vm.warp(block.timestamp + 60);
        assertTrue(!book.poke(key), "and no fire");
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(posId, both, 0);
        assertEq(rv.balanceOf(OWNER), 1000e18, "the owner keeps the position");
    }

    /// Control: one honest sample in the period after the flash roll pulls the candidate back down, and nothing fires.
    function test_V3_01_control_oneHonestSamplePerPeriodPreventsIt() public {
        _flashRoll();
        vm.warp(block.timestamp + 600);
        book.checkpoint(key); // the keeper's sample
        vm.warp(block.timestamp + WINDOW / 2 - 600);
        book.checkpoint(key);
        (uint256 snap,) = _snaps();
        assertEq(snap, 1000e18, "reference stays honest");
        assertTrue(!book.check(key), "nothing to fire");
    }

    /// An attacker who lands a flash deposit on every roll for a day, against a keeper that samples (and pokes) every 10
    /// minutes, never fires the key: each of its inflated candidates is pulled down by the keeper's next sample.
    function test_V3_01_attackerWhoWinsEachRoll_againstAKeeperSamplingEachPeriod_neverFires() public {
        uint256 end = block.timestamp + 1 days;
        uint256 rolls;
        while (block.timestamp < end) {
            (,, uint64 snapAt,,,,,) = book.state(key);
            vm.warp(uint256(snapAt) + WINDOW / 2); // the roll moment: the attacker gets there first
            asset.mint(address(fa), LOAN);
            fa.flash(book, rv, key, LOAN);
            (,, uint64 rolledAt,,,,,) = book.state(key);
            assertEq(rolledAt, block.timestamp, "the attacker's flash sample rolled the period");
            ++rolls;
            for (uint256 i; i < 2; ++i) {
                vm.warp(block.timestamp + 600);
                book.checkpoint(key); // the keeper's samples inside the period
                assertTrue(!book.poke(key), "never fires");
            }
        }
        assertTrue(rolls >= 40, "the attacker took every roll of the day");
        assertTrue(!book.isLive(key, 1 days), "nothing fired");
        assertEq(rv.totalAssets(), 1000e18, "never drained");
    }

    /// The boundary the fix keeps, pinned: an attacker who wins two consecutive rolls with no honest sample in between
    /// (two whole unsampled periods) makes both period lows inflated, and can then fire. A keeper sampling once a period
    /// prevents it (the control above, and the test before this one).
    function test_V3_01_twoUnsampledPeriodsAreNeeded_documentedLimit() public {
        _flashRoll(); // period 1: only the flash sample
        vm.warp(block.timestamp + WINDOW / 2);
        asset.mint(address(fa), LOAN);
        fa.flash(book, rv, key, LOAN); // roll: snap 1500, prevSnap 1000; period 2: only the flash sample again
        assertTrue(!book.check(key), "one unsampled period is not enough");
        vm.warp(block.timestamp + WINDOW / 2);
        asset.mint(address(fa), LOAN);
        fa.flash(book, rv, key, LOAN); // roll: snap 1500, prevSnap 1500
        (uint256 snap, uint256 prevSnap) = _snaps();
        assertTrue(snap == 1500e18 && prevSnap == 1500e18, "both period lows inflated");
        assertTrue(!book.poke(key), "sighting");
        vm.warp(block.timestamp + 60);
        assertTrue(book.poke(key), "the DRAIN part fires after two unsampled periods");
        // But a DRAIN key is only ever armed inside BOTH, which also needs the watchers' quorum: no exit without it.
        assertTrue(!book.poke(both), "BOTH stays silent without the quorum");
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(posId, both, 0);
    }

    /// A real drain still fires within one window of the reference being live.
    function test_V3_01_realDrainStillFires() public {
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key); // second honest roll: the reference is live
        rv.exploitDrain(ATTACKER, 300e18);
        assertTrue(!book.poke(key), "sighting");
        vm.warp(block.timestamp + 60);
        assertTrue(book.poke(key), "fires a minute later");
        _fireQuorum(); // the watchers confirm the exploit
        assertTrue(book.poke(both), "BOTH fires");
        vm.prank(KEEPER);
        router.exit(posId, both, 0);
        assertEq(asset.balanceOf(OWNER), 700e18, "the owner gets what is left");
    }
}
