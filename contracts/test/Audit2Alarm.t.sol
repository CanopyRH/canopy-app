// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {Timelock} from "../src/Timelock.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {MockERC20, MockVault, MockOwned} from "./Mocks.sol";
import {RealVault} from "./AlarmAttacks.t.sol";

interface VmEtch {
    function etch(address, bytes calldata) external;
}

/// @dev Stands in for a large depositor who can move a vault's totalAssets inside one transaction.
contract Audit2Whale {
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

/// @dev Flash deposit that samples twice in one transaction. Only a tiny-window DRAIN detector lets that move the reference.
contract Audit2DoubleSampler {
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
contract Audit2Wallet1271 {
    bytes32 public okHash;

    function set(bytes32 h) external {
        okHash = h;
    }

    function isValidSignature(bytes32 h, bytes memory) external view returns (bytes4) {
        return h == okHash ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract Audit2Reverter {
    fallback() external {
        revert();
    }
}

/// @notice Audit 2 proofs of concept for AlarmBook and its interaction with ExitRouter.
/// None of these moves funds to anyone but the owner. They show early or repeated exits, blinded alarms and doc gaps.
contract Audit2AlarmTest is Base {
    uint256 internal constant PK_A = 0xA1;
    uint256 internal constant PK_B = 0xB2;
    uint32 internal constant WINDOW = 3600;
    bytes32 internal constant EVIDENCE = keccak256("report");
    address internal constant OWNER2 = address(0xCAFE02);

    function setUp() public override {
        super.setUp();
        vm.startPrank(ADMIN);
        book.setWatcher(vm.addr(PK_A), true);
        book.setWatcher(vm.addr(PK_B), true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _armWith(address who, address target, bytes32 key) internal returns (bytes32 id) {
        vm.prank(who);
        MockERC20(target).approve(address(router), type(uint256).max);
        vm.prank(who);
        id = router.arm(_params(target, 0, 0, _keys(key)));
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

    // ------------------------------------------------------------------ A2-01: a tripped detector can never be reset

    /// SHARE_DROP: after a real, lasting loss the high-water mark stays put. The key refires every 24 hours,
    /// and whoever arms it afterwards is exited at the next refire.
    function test_A2_01_shareDropStaysTrippedAndRefiresEveryDay() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
        vault.setPrice(0.98e6); // a 2% loss that is never made good
        assertTrue(book.poke(k), "first fire");
        uint256 t0 = block.timestamp;

        // Nothing can lower the mark.
        book.checkpoint(k);
        (,,, uint256 base,) = book.state(k);
        assertEq(base, 1e6, "mark unchanged by checkpoint");

        // A new depositor arms the key an hour later, as the app's "Vault loss" preset would let them.
        vm.warp(t0 + 1 hours);
        vault.deposit(OWNER2, 100e18);
        bytes32 id = _armWith(OWNER2, address(vault), k);
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector); // the first firing doesn't count (L-1 from the earlier review)
        router.exit(id, k, 0);

        // 24 hours after the first firing the key fires again, with the vault unchanged, and the keeper exits OWNER2.
        vm.warp(t0 + 1 days);
        assertTrue(book.check(k), "still tripped");
        assertTrue(book.poke(k), "refire");
        vm.prank(KEEPER);
        router.exit(id, k, 0);
        assertEq(stable.balanceOf(OWNER2), 98e6, "owner2 was exited at the refire");

        // And it keeps going: 200 days later the key is still tripped.
        vm.warp(t0 + 200 days);
        assertTrue(book.check(k), "tripped 200 days later");
    }

    /// ADDRESS_CHANGE: the registered address never updates, so one legitimate change trips the key for good.
    function test_A2_01b_addressChangeStaysTrippedAfterALegitimateChange() public {
        MockOwned owned = new MockOwned(address(0x111));
        bytes32 sel = bytes32(bytes4(keccak256("curator()")));
        bytes32 k = book.register(_detector(AlarmBook.Kind.ADDRESS_CHANGE, address(owned), 0, 0, sel, 0));
        owned.setCurator(address(0x222)); // an announced, harmless handover
        assertTrue(book.poke(k), "fires once");
        vm.warp(block.timestamp + 30 days);
        assertTrue(book.check(k), "a month later the key is still tripped and refires");
        (,,, uint256 base,) = book.state(k);
        assertEq(base, uint256(uint160(address(0x111))), "baseline is still the old curator");
    }

    /// The pinned poison test (AlarmAttacks.t.sol test_poisonedShareMark_cantExitALaterUser) only looks one second ahead.
    /// The poisoned key is still tripped 24 hours after its first firing, refires, and then exits the user who armed after it.
    function test_A2_01c_poisonedShareMarkExitsALaterUserAtTheRefire() public {
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

        vm.warp(t0 + 1);
        asset.mint(OWNER, 100e18);
        vm.startPrank(OWNER);
        asset.approve(address(rv), 100e18);
        rv.deposit(100e18, OWNER);
        rv.approve(address(router), type(uint256).max);
        bytes32 id = router.arm(_params(address(rv), 0, 0, _keys(key)));
        vm.stopPrank();

        vm.warp(t0 + 2);
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, key, 0); // what the existing test pins

        vm.warp(t0 + 1 days); // the next day the poisoned mark still reads as a drop and the key refires
        assertTrue(book.poke(key), "refires on the same poisoned mark");
        vm.prank(ATTACKER);
        router.exit(id, key, 0);
        assertEq(asset.balanceOf(OWNER), 100e18, "the later user was exited by the attacker's poison");
    }

    // ------------------------------------------------------------------ A2-02: DRAIN trusts one low reading

    function _drainWorld() internal returns (RealVault rv, Audit2Whale whale, bytes32 key, MockERC20 asset) {
        asset = new MockERC20(18);
        rv = new RealVault(asset);
        whale = new Audit2Whale();
        asset.mint(address(whale), 400e18);
        whale.deposit(rv, 400e18);
        asset.mint(address(this), 600e18);
        asset.approve(address(rv), 600e18);
        rv.deposit(600e18, address(this));
        key = book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2500, WINDOW, 0, 0));
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key); // first roll: reference 1000
    }

    /// A depositor holding 40% of the vault withdraws, pokes, and deposits back in one transaction. The alarm fires
    /// with no loss, and a position armed with the bare DRAIN key is exited. (The app only offers DRAIN inside BOTH
    /// with a quorum, so this reaches custom keys only.)
    function test_A2_02_flashWithdrawalFiresDrainWithNoLoss() public {
        (RealVault rv, Audit2Whale whale, bytes32 key, MockERC20 asset) = _drainWorld();
        rv.transfer(OWNER, 100e18);
        vm.prank(OWNER);
        rv.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(rv), 0, 0, _keys(key)));

        assertTrue(whale.dip(book, rv, key, 400e18, true), "the alarm fires inside the dip");
        assertEq(rv.totalAssets(), 1000e18, "vault whole again");
        assertEq(asset.balanceOf(address(whale)), 0, "whale fully redeposited");

        vm.prank(KEEPER);
        router.exit(id, key, 0);
        assertEq(asset.balanceOf(OWNER), 100e18, "owner exited early on a false alarm");
    }

    /// A depositor with 40% of the vault dips just under the threshold in two consecutive periods, sampling with
    /// checkpoint each time (the lowest sample of a period becomes the next reference, and a sample that would trip the
    /// alarm is refused). The reference falls to 60% of the real level, so a real 50% loss no longer fires. The control
    /// world, without the dips, fires. Each dip is undone in the same transaction, so it costs only gas.
    function test_A2_02b_lowSamplesBlindALaterRealDrain() public {
        bool blind;
        for (uint256 pass; pass < 2; ++pass) {
            (RealVault rv, Audit2Whale whale, bytes32 key,) = _drainWorld();
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

    /// DRAIN windows of 1 or 2 seconds are accepted. Their roll interval is window/2 = 0 or 1 seconds, so two samples
    /// inside one flash deposit make the inflated reading the reference.
    function test_A2_02c_tinyDrainWindowIsFlashManipulable() public {
        MockERC20 asset = new MockERC20(18);
        RealVault rv = new RealVault(asset);
        asset.mint(address(this), 1000e18);
        asset.approve(address(rv), 1000e18);
        rv.deposit(1000e18, address(this));
        bytes32 key = book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2500, 1, 0, 0));
        vm.warp(block.timestamp + 1);
        Audit2DoubleSampler s = new Audit2DoubleSampler();
        asset.mint(address(s), 334e18);
        assertTrue(s.run(book, rv, key, 334e18), "false drain fired by a flash deposit");
        // The canonical 3600 s window rejects the same attack (see AlarmAttacks.t.sol test_flashDeposit_cantRaiseTheBaseline).
    }

    // ------------------------------------------------------------------ A2-03: QUORUM signatures with a far deadline

    /// The 1-hour cap is measured at fire time, not at signing time. Signatures made with a 30-day deadline can't fire
    /// for 30 days minus an hour, then anyone holding them can fire in the last hour.
    function test_A2_03_farDeadlineAttestationIsABearerTokenInItsLastHour() public {
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

    // ------------------------------------------------------------------ A2-04: the admin controls the watcher list for ever

    function test_A2_04_adminWatchersFireQuorumKeysAfterRouterAdminExpiry() public {
        address proposer = address(0x9999);
        Timelock tl = new Timelock(proposer, 0); // the live setup: delay 0
        AlarmBook b2 = new AlarmBook(address(tl));
        uint256 expiry = block.timestamp + 365 days;
        ExitRouter r2 = new ExitRouter(
            address(stable), address(weth), address(swap), address(b2), address(tl), GUARD, address(stableFeed), 90_000, expiry
        );
        ERC4626Adapter a2 = new ERC4626Adapter(address(r2));
        _exec(tl, proposer, address(r2), abi.encodeCall(ExitRouter.setAdapter, (address(a2), true)));

        // A holder arms "Exploit confirmed", a QUORUM key.
        bytes32 qk = b2.register(_detector(AlarmBook.Kind.QUORUM, address(vault), 2, 0, 0, 0));
        vault.deposit(OWNER, 100e18);
        vm.prank(OWNER);
        vault.approve(address(r2), type(uint256).max);
        ExitRouter.ArmParams memory p = _params(address(vault), 0, 0, _keys(qk));
        p.adapter = address(a2);
        vm.prank(OWNER);
        bytes32 id = r2.arm(p);

        // After the router's admin expires, the router can't be touched, but the watcher list still can.
        vm.warp(expiry + 1);
        _execExpectFail(tl, proposer, address(r2), abi.encodeCall(ExitRouter.setAdapter, (address(a2), false)));

        _exec(tl, proposer, address(b2), abi.encodeCall(AlarmBook.setWatcher, (vm.addr(PK_A), true)));
        _exec(tl, proposer, address(b2), abi.encodeCall(AlarmBook.setWatcher, (vm.addr(PK_B), true)));

        // Whoever holds two watcher keys (here the same people who control the admin) forces every QUORUM-armed position out.
        uint64 dl = uint64(block.timestamp + 600);
        (address[] memory s, bytes[] memory g) = _sigsFor(b2.attestDigest(qk, EVIDENCE, dl));
        b2.fireByQuorum(qk, EVIDENCE, dl, s, g);
        vm.prank(KEEPER);
        r2.exit(id, qk, 0);
        assertEq(stable.balanceOf(OWNER), 100e6, "owner exited early, and was still the only one paid");
        assertEq(stable.balanceOf(KEEPER), 0, "keeper got nothing");
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

    // ------------------------------------------------------------------ A2-05: "fired after you armed" is "fired at or after"

    function test_A2_05_alarmFiredEarlierInTheSameSecondAuthorizesAKeeper() public {
        vault.deposit(OWNER, 100e18);
        pausable.setPaused(true);
        assertTrue(book.poke(pauseKey), "fires");
        // Same timestamp, a later block: the owner arms with the key that has just fired.
        vm.prank(OWNER);
        vault.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(vault), 0, 0, _keys(pauseKey)));
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(stable.balanceOf(OWNER), 100e6, "exited on a firing that came before the arming");
    }

    function test_A2_05b_oneSecondLaterItIsRefused() public {
        vault.deposit(OWNER, 100e18);
        pausable.setPaused(true);
        assertTrue(book.poke(pauseKey), "fires");
        vm.warp(block.timestamp + 1);
        vm.prank(OWNER);
        vault.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(vault), 0, 0, _keys(pauseKey)));
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, pauseKey, 0);
    }

    // ------------------------------------------------------------------ checks that pass (coverage gaps in the suite)

    /// The live-path of ERC-1271 (a contract watcher that approves) was never exercised.
    function test_A2_C1_contractWatcherThatApprovesCanSign() public {
        Audit2Wallet1271 w = new Audit2Wallet1271();
        vm.prank(ADMIN);
        book.setWatcher(address(w), true);
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
    function test_A2_C2_eoaWithCodeFallsBackToEcdsa() public {
        address a = vm.addr(PK_A);
        VmEtch(address(uint160(uint256(keccak256("hevm cheat code"))))).etch(a, address(new Audit2Reverter()).code);
        bytes32 qk = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xBEEF), 2, 0, 0, 0));
        uint64 dl = uint64(block.timestamp + 600);
        (address[] memory s, bytes[] memory g) = _sigsFor(book.attestDigest(qk, EVIDENCE, dl));
        book.fireByQuorum(qk, EVIDENCE, dl, s, g);
        assertTrue(book.isLive(qk, 1), "fired");
    }

    /// A signature made for another chain id is no good: the domain separator binds block.chainid at deploy.
    function test_A2_C3_signatureForAnotherDeploymentIsRejected() public {
        AlarmBook other = new AlarmBook(ADMIN);
        bytes32 qk = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xBEEF), 2, 0, 0, 0));
        uint64 dl = uint64(block.timestamp + 600);
        (address[] memory s, bytes[] memory g) = _sigsFor(other.attestDigest(qk, EVIDENCE, dl));
        vm.expectRevert(abi.encodeWithSelector(AlarmBook.BadSignature.selector, s[0]));
        book.fireByQuorum(qk, EVIDENCE, dl, s, g);
    }
}
