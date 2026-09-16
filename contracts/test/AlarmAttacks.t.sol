// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {Timelock} from "../src/Timelock.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {MockERC20, MockVault, MockFeed} from "./Mocks.sol";

/// @dev ERC-4626 with real custody: totalAssets is the vault's token balance and deposits and redeems move real tokens.
contract RealVault is MockERC20 {
    MockERC20 public immutable assetToken;

    constructor(MockERC20 a) MockERC20(18) {
        assetToken = a;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function totalAssets() public view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    function convertToAssets(uint256 s) public view returns (uint256) {
        return totalSupply == 0 ? s : (s * totalAssets()) / totalSupply;
    }

    function maxRedeem(address o) external view returns (uint256) {
        return balanceOf[o];
    }

    function deposit(uint256 a, address to) external returns (uint256 s) {
        s = totalSupply == 0 ? a : (a * totalSupply) / totalAssets();
        assetToken.transferFrom(msg.sender, address(this), a);
        mint(to, s);
    }

    function redeem(uint256 s, address receiver, address owner) external returns (uint256 a) {
        require(msg.sender == owner, "owner");
        a = convertToAssets(s);
        _burn(owner, s);
        assetToken.transfer(receiver, a);
    }

    /// @dev Stand-in for a real exploit that takes assets out of the vault.
    function exploitDrain(address to, uint256 a) external {
        assetToken.transfer(to, a);
    }
}

/// @dev One transaction. Its token balance stands in for a free flash loan.
contract FlashAttacker {
    function flash(AlarmBook book, RealVault v, bytes32 key, uint256 loan) external {
        v.assetToken().approve(address(v), loan);
        uint256 s = v.deposit(loan, address(this));
        book.checkpoint(key);
        v.redeem(s, address(this), address(this));
    }
}

/// @notice Each of these was a working attack in an internal review. They now pin the fixes.
contract AlarmAttackTest is Base {
    uint256 internal constant PK_A = 0xA1;
    uint256 internal constant PK_B = 0xB2;
    uint32 internal constant WINDOW = 3600;
    bytes32 internal constant EVIDENCE = keccak256("report");

    MockERC20 internal asset;
    RealVault internal rv;
    FlashAttacker internal fa;

    function setUp() public override {
        super.setUp();
        asset = new MockERC20(18);
        rv = new RealVault(asset);
        fa = new FlashAttacker();
        vm.startPrank(ADMIN);
        book.setWatcher(vm.addr(PK_A), true);
        book.setWatcher(vm.addr(PK_B), true);
        vm.stopPrank();
    }

    function _deposit(address who, uint256 a) internal {
        asset.mint(who, a);
        vm.prank(who);
        asset.approve(address(rv), a);
        vm.prank(who);
        rv.deposit(a, who);
    }

    function _arm(address who, bytes32[] memory keys) internal returns (bytes32) {
        vm.prank(who);
        rv.approve(address(router), type(uint256).max);
        vm.prank(who);
        return router.arm(_params(address(rv), 0, 0, keys));
    }

    function _drainKey() internal returns (bytes32) {
        return book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2500, WINDOW, 0, 0));
    }

    /// @dev The app's "Vault drain + confirmation" preset.
    function _bothKeys() internal returns (bytes32 drain, bytes32 quorum, bytes32 both) {
        drain = _drainKey();
        quorum = book.register(_detector(AlarmBook.Kind.QUORUM, address(rv), 2, 0, 0, 0));
        both = book.register(_detector(AlarmBook.Kind.BOTH, address(rv), 0, 1 days, drain, quorum));
    }

    /// @dev A keeper's routine pass, with a baseline ready at the end of it.
    function _period(bytes32 key) internal {
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key);
    }

    function _sigs(bytes32 digest) internal returns (address[] memory s, bytes[] memory g) {
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

    function _fireQuorum(bytes32 key) internal {
        uint64 dl = uint64(block.timestamp + 600);
        (address[] memory s, bytes[] memory g) = _sigs(book.attestDigest(key, EVIDENCE, dl));
        book.fireByQuorum(key, EVIDENCE, dl, s, g);
    }

    function _reallyDrain(bytes32 drain) internal {
        rv.exploitDrain(ATTACKER, 800e18);
        assertTrue(book.poke(drain), "a real drain fires");
    }

    function test_flashDeposit_cantRaiseTheBaseline() public {
        _deposit(OWNER, 1000e18);
        bytes32 key = _drainKey();
        _period(key);
        vm.warp(block.timestamp + WINDOW / 2);
        asset.mint(address(fa), 334e18);
        fa.flash(book, rv, key, 334e18); // lands on the roll, the attacker's best moment
        assertTrue(!book.check(key), "the alarm doesn't fire on a deposit that came and went");
    }

    function test_flashDeposit_onANewDetector_cantFire() public {
        _deposit(OWNER, 1000e18);
        bytes32 key = _drainKey();
        vm.warp(block.timestamp + WINDOW / 2);
        asset.mint(address(fa), 334e18);
        fa.flash(book, rv, key, 334e18);
        assertTrue(!book.check(key), "still measured against the honest first reading");
    }

    function test_flashSample_isPulledDownByTheNextHonestSample() public {
        _deposit(OWNER, 1000e18);
        bytes32 key = _drainKey();
        _period(key);
        vm.warp(block.timestamp + WINDOW / 2);
        asset.mint(address(fa), 334e18);
        fa.flash(book, rv, key, 334e18); // the next baseline candidate is now inflated
        vm.warp(block.timestamp + 600);
        book.checkpoint(key); // a keeper sample, in the same period
        vm.warp(block.timestamp + WINDOW / 2 - 600);
        book.checkpoint(key);
        (,,,, uint256 snap) = book.state(key);
        assertEq(snap, 1000e18, "the inflated reading never became the baseline");
        assertTrue(!book.check(key), "healthy");
    }

    function test_flashDeposit_cantRaiseAQuorumFiredBoth() public {
        _deposit(OWNER, 1000e18);
        (bytes32 drain, bytes32 quorum, bytes32 both) = _bothKeys();
        _arm(OWNER, _keys(both));
        _period(drain);
        _fireQuorum(quorum);
        vm.warp(block.timestamp + WINDOW / 2);
        asset.mint(address(fa), 334e18);
        fa.flash(book, rv, drain, 334e18);
        assertTrue(!book.poke(drain), "no drain to fire on");
        assertTrue(!book.poke(both), "the combined alarm stays silent");
    }

    function test_midDrainCheckpoint_cantHideADrain() public {
        _deposit(OWNER, 1000e18);
        bytes32 key = _drainKey();
        _period(key);
        rv.exploitDrain(ATTACKER, 249e18); // under the threshold, so checkpoint runs
        book.checkpoint(key);
        rv.exploitDrain(ATTACKER, 187e18);
        assertEq(rv.totalAssets(), 564e18, "43.6% gone");
        assertTrue(book.poke(key), "the baseline didn't move, so it fires");
    }

    function test_midDrainRoll_cantHideADrain() public {
        _deposit(OWNER, 1000e18);
        bytes32 key = _drainKey();
        _period(key);
        vm.warp(block.timestamp + WINDOW / 2);
        rv.exploitDrain(ATTACKER, 249e18);
        book.checkpoint(key); // rolls in the middle of the drain
        rv.exploitDrain(ATTACKER, 187e18);
        assertTrue(book.poke(key), "the roll took the earlier low, not the drained value");
    }

    function test_flashDeposit_cantResetATrippedDrain() public {
        _deposit(OWNER, 1000e18);
        bytes32 key = _drainKey();
        _period(key);
        vm.warp(block.timestamp + WINDOW / 2);
        rv.exploitDrain(ATTACKER, 350e18);
        assertTrue(book.check(key), "tripped");
        book.checkpoint(key);
        asset.mint(address(fa), 100e18);
        fa.flash(book, rv, key, 100e18); // 750 for one call, so the tripped check passes
        assertTrue(book.check(key), "still tripped against the real baseline");
    }

    function test_samplesDuringATrippedDrain_cantLowerTheNextBaseline() public {
        _deposit(OWNER, 1000e18);
        bytes32 key = _drainKey();
        _period(key);
        rv.exploitDrain(ATTACKER, 350e18);
        vm.warp(block.timestamp + 600);
        book.checkpoint(key); // tripped, so this must not record the drained value as a low
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key);
        assertTrue(book.check(key), "still measured against the level before the drain");
    }

    function test_quietVault_baselineFollowsRealGrowth() public {
        _deposit(OWNER, 1000e18);
        bytes32 key = _drainKey();
        _period(key);
        _deposit(KEEPER, 1000e18);
        _period(key);
        _period(key);
        (,,,, uint256 snap) = book.state(key);
        assertEq(snap, 2000e18, "lasting deposits raise the baseline after a full period");
    }

    function test_preburnedDrain_stillLetsARealHackFireBoth() public {
        _deposit(OWNER, 1000e18);
        (bytes32 drain, bytes32 quorum, bytes32 both) = _bothKeys();
        bytes32 id = _arm(OWNER, _keys(both));
        _period(drain);
        vm.warp(block.timestamp + 1);
        rv.exploitDrain(ATTACKER, 300e18);
        assertTrue(book.poke(drain), "an honest large withdrawal fires the drain part");
        asset.mint(address(rv), 300e18);

        vm.warp(block.timestamp + WINDOW + 1); // past the old one-hour window
        rv.exploitDrain(ATTACKER, 800e18);
        _fireQuorum(quorum);
        assertTrue(book.poke(both), "the combined alarm fires");
        vm.prank(KEEPER);
        router.exit(id, both, 0);
        assertEq(rv.balanceOf(OWNER), 0, "owner got out");
    }

    function test_lateConfirmation_stillFiresBoth() public {
        _deposit(OWNER, 1000e18);
        (bytes32 drain, bytes32 quorum, bytes32 both) = _bothKeys();
        bytes32 id = _arm(OWNER, _keys(both));
        _period(drain);
        vm.warp(block.timestamp + 1);
        _reallyDrain(drain);
        vm.warp(block.timestamp + 23 hours); // a report that takes most of a day
        _fireQuorum(quorum);
        assertTrue(book.poke(both), "fires");
        vm.prank(KEEPER);
        router.exit(id, both, 0);
        assertEq(asset.balanceOf(OWNER), 200e18, "owner gets what is left");
    }

    function test_reusedSignatures_cantOutliveTheRefireDelay() public {
        bytes32 key = book.register(_detector(AlarmBook.Kind.QUORUM, address(rv), 2, 0, 0, 0));
        uint64 dl = uint64(block.timestamp + 3 days);
        (address[] memory s, bytes[] memory g) = _sigs(book.attestDigest(key, EVIDENCE, dl));
        vm.expectRevert(AlarmBook.DeadlineTooFar.selector);
        book.fireByQuorum(key, EVIDENCE, dl, s, g);
    }
}
