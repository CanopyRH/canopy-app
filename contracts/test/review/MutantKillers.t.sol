// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.sol";
import {AlarmBook} from "../../src/AlarmBook.sol";
import {ExitRouter} from "../../src/ExitRouter.sol";
import {MockERC20, MockVault, MockFeed, MockPausable} from "../Mocks.sol";

/// @notice Tests for behaviour the existing suite leaves unpinned: each kills a mutant that survived the hand-written
/// mutation campaign of this review (the mutant is named in each test). All pass on this commit.
contract MutantKillersTest is Base {
    MockERC20 internal t;
    MockFeed internal tFeed;
    MockVault internal tVault;

    function setUp() public override {
        super.setUp();
        t = new MockERC20(18);
        tFeed = new MockFeed(100e8);
        tVault = new MockVault(t, 1e18);
    }

    /// Mutant "arm: old keys not cleared". Re-arming must revoke the keys it drops: a key the owner removed can't be
    /// used by a third party even when it fires later.
    function test_reArm_revokesDroppedKeys() public {
        bytes32 id = _setup(OWNER, vault, 10e18, 0, 0); // armed with pauseKey
        MockPausable p2 = new MockPausable();
        bytes32 k2 = book.register(_detector(AlarmBook.Kind.PAUSED, address(p2), 0, 0, 0, 0));
        vm.prank(OWNER);
        router.arm(_params(address(vault), 0, 0, _keys(k2))); // pauseKey dropped
        assertTrue(!router.keyArmed(id, pauseKey), "dropped key is not armed");
        _fireAlarm(); // the dropped key fires after the re-arm
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotAuthorized.selector);
        router.exit(id, pauseKey, 0);
    }

    /// Mutant "register: re-register resets". Registering an existing key again must not touch its state: a live
    /// alarm stays live (or anyone could cancel a fire and lock keepers out), and the share mark stays.
    function test_reRegister_preservesFiredAtAndMarks() public {
        _setup(OWNER, vault, 10e18, 0, 0);
        bytes32 sk = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
        vault.setPrice(2e6);
        book.checkpoint(sk); // mark 2e6
        _fireAlarm();
        (bool e0, uint64 f0,,,,,,) = book.state(pauseKey);
        book.register(_detector(AlarmBook.Kind.PAUSED, address(pausable), 0, 0, 0, 0));
        vault.setPrice(1e6);
        book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
        (bool e1, uint64 f1,,,,,,) = book.state(pauseKey);
        (,,, uint256 mark,,,,) = book.state(sk);
        assertTrue(e0 && e1 && f0 == f1 && f1 != 0, "fire kept");
        assertEq(mark, 2e6, "mark kept, so the 50% drop still reads tripped");
        assertTrue(book.check(sk), "tripped");
    }

    /// Mutant "unwind: stable not netted". Stablecoin someone sent the router is not exit proceeds and must not be paid
    /// to the next owner who exits (R7: gifts are never swept).
    function test_stableDonation_isNotPaidToAnExitingOwner() public {
        bytes32 id = _setup(OWNER, vault, 10e18, 0, 0);
        stable.mint(address(router), 5e6);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(stable.balanceOf(OWNER), 10e6, "exactly the redemption");
        assertEq(stable.balanceOf(address(router)), 5e6, "the gift stays");
    }

    /// Mutant "swap: first leg for any token". With two legs, each output must use its own token's leg.
    function test_twoLegs_eachTokenUsesItsOwnLeg() public {
        MockERC20 u = new MockERC20(18);
        MockFeed uFeed = new MockFeed(1e8); // $1: its leg's oracle minimum is far below t's
        ExitRouter.SwapLeg[] memory legs = new ExitRouter.SwapLeg[](2);
        legs[0] = _leg(address(u), address(uFeed));
        legs[1] = _leg(address(t), address(tFeed));
        bytes32 id = _setupSwap(OWNER, tVault, 1e18, 50, legs);
        swap.setRate(2e6); // $2 per t: fine against u's $1 oracle, a 98% loss against t's $100
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(t.balanceOf(OWNER), 1e18, "t priced by its own leg: swap refused, raw paid");
    }

    /// Mutant "legs: path alignment off". A path whose length is not 20 + 23k is refused at arming.
    function test_arm_rejectsMisalignedPathAbove43Bytes() public {
        ExitRouter.SwapLeg memory l = _leg(address(t), address(tFeed));
        l.path = abi.encodePacked(address(t), uint24(500), bytes1(0x00), address(stable)); // 44 bytes
        tVault.deposit(OWNER, 1e18);
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.BadRoute.selector);
        router.arm(_swapParams(address(tVault), 50, _keys(pauseKey), _legs(l)));
    }

    /// Mutant "quote: ok always". An amount worth less than one unit of the stablecoin is never swapped at minimum 0.
    function test_quote_dustIsNotSwappable() public view {
        (bool ok, uint256 minOut) = router.quoteMinOut(address(tFeed), 3600, 18, 1, 0);
        assertTrue(!ok && minOut == 0, "dust: no swap");
    }
}
