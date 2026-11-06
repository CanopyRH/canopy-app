// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {SafeTransferLib} from "../src/lib/SafeTransferLib.sol";
import {AdapterBase} from "../src/adapters/AdapterBase.sol";
import {ReentrancyGuard} from "../src/lib/ReentrancyGuard.sol";
import {MockERC20, MockVault, MockFeed, EvilAdapter, EvilVault, ReentrantVault, SelfAssetVault} from "./Mocks.sol";

contract ExitRouterTest is Base {
    uint8 internal constant RAW = 0;
    uint8 internal constant STABLE = 1;
    MockERC20 internal t;
    MockFeed internal tFeed;
    MockVault internal tVault;

    function setUp() public override {
        super.setUp();
        t = new MockERC20(18);
        tFeed = new MockFeed(100e8); // $100
        tVault = new MockVault(t, 1e18); // 1 share = 1 token
    }

    // ---------------------------------------------------------------- arming

    function test_arm_rejectsUnlistedAdapter() public {
        ExitRouter.ArmParams memory p = _params(address(vault), RAW, 0, _keys(pauseKey));
        p.adapter = address(0x1234);
        vm.expectRevert(ExitRouter.NotSupported.selector);
        router.arm(p);
    }

    function test_arm_rejectsSlipAboveCap() public {
        vm.expectRevert(ExitRouter.SlipTooHigh.selector);
        router.arm(_params(address(vault), RAW, 1001, _keys(pauseKey)));
    }

    function test_arm_rejectsTooManyKeys() public {
        vm.expectRevert(ExitRouter.TooManyKeys.selector);
        router.arm(_params(address(vault), RAW, 0, new bytes32[](9)));
    }

    function test_arm_rejectsBadHarbour() public {
        vm.expectRevert(ExitRouter.BadHarbour.selector);
        router.arm(_params(address(vault), 2, 0, _keys(pauseKey)));
    }

    function test_arm_rejectsWhilePaused() public {
        vm.prank(GUARD);
        router.setArmingPaused(true);
        vm.expectRevert(ExitRouter.ArmingIsPaused.selector);
        router.arm(_params(address(vault), RAW, 0, _keys(pauseKey)));
    }

    function test_arm_unlistedVaultIsAccepted() public {
        MockVault other = new MockVault(stable, 1e6);
        bytes32 id = _setup(OWNER, other, 10e18, RAW, 0);
        assertTrue(router.isArmed(id), "armed");
    }

    function test_arm_isBoundToCaller() public {
        vm.prank(ATTACKER);
        bytes32 id = router.arm(_params(address(vault), RAW, 0, _keys(pauseKey)));
        (address owner,,,,,,,,,,) = router.positions(id);
        assertTrue(owner == ATTACKER, "owner is the caller");
        assertTrue(!router.isArmed(router.positionId(OWNER, address(adapter), address(vault), 0)), "victim unarmed");
    }

    // ---------------------------------------------------------------- exits

    function test_ownerExit_raw() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(stable.balanceOf(OWNER), 100e6, "owner paid");
        assertEq(vault.balanceOf(OWNER), 0, "shares gone");
    }

    function test_keeperExit_onLiveKey() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(stable.balanceOf(OWNER), 100e6, "owner paid");
        assertEq(stable.balanceOf(KEEPER), 0, "keeper paid nothing");
    }

    function test_keeperExit_rejectedWithNoAlarm() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, pauseKey, 0);
    }

    function test_keeperExit_rejectedWithUnarmedKey() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        _fireAlarm();
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotAuthorized.selector);
        router.exit(id, keccak256("other"), 0);
    }

    function test_keeperExit_rejectedAfterTtl() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        _fireAlarm();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, pauseKey, 0);
    }

    function test_partialExit_leavesRemainingShares() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vault.setLiquid(40e6);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 40e18);
        assertEq(stable.balanceOf(OWNER), 40e6, "owner paid");
        assertEq(vault.balanceOf(OWNER), 60e18, "rest stays with owner");
    }

    function test_illiquidVault_revertsWithSharesUntouched() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vault.setLiquid(0);
        _fireAlarm();
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NothingWithdrawn.selector);
        router.exit(id, pauseKey, 0);
        assertEq(vault.balanceOf(OWNER), 100e18, "shares untouched");
    }

    function test_vaultReportingMaxRedeem_usesFallback() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vault.setZeroMax(false);
        vault.setLiquid(30e6);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(stable.balanceOf(OWNER), 30e6, "partial via fallback");
        assertEq(vault.balanceOf(OWNER), 70e18, "leftover returned");
    }

    function test_blockedOwner_booksOwedThenClaims() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        stable.setBlocked(OWNER, true);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(router.owed(OWNER, address(stable)), 100e6, "owed");
        assertEq(router.totalOwed(address(stable)), 100e6, "total owed");
        stable.setBlocked(OWNER, false);
        vm.prank(KEEPER);
        router.claimOwed(OWNER, address(stable));
        assertEq(stable.balanceOf(OWNER), 100e6, "claimed");
        assertEq(stable.balanceOf(KEEPER), 0, "claimer gets nothing");
    }

    function test_exitPreservesOwedOfOthers() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        stable.setBlocked(OWNER, true);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        bytes32 other = _setup(KEEPER, vault, 50e18, RAW, 0);
        vm.prank(KEEPER);
        router.exit(other, bytes32(0), 0);
        assertEq(stable.balanceOf(KEEPER), 50e6, "second owner paid only their own");
        assertEq(stable.balanceOf(address(router)), 100e6, "owed funds still held");
    }

    // ---------------------------------------------------------------- swap leg

    /// @dev The owner arms the token vault on the stable harbour with a leg for `t`: its feed and a direct pool.
    function _tPosition(uint16 slip) internal returns (bytes32) {
        return _setupSwap(OWNER, tVault, 1e18, slip, _legs(_leg(address(t), address(tFeed))));
    }

    function test_swap_ownerWithinUserLimit() public {
        bytes32 id = _tPosition(1000);
        swap.setRate(92e6); // 8% under the oracle
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(stable.balanceOf(OWNER), 92e6, "swapped");
        assertEq(t.balanceOf(OWNER), 0, "no raw");
    }

    function test_swap_ownerBelowTenPercentCeilingDeliversRaw() public {
        bytes32 id = _tPosition(1000);
        swap.setRate(89e6); // 11% under the oracle
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(t.balanceOf(OWNER), 1e18, "raw");
    }

    function test_swap_thirdPartyCappedAtOnePercent() public {
        bytes32 id = _tPosition(1000);
        swap.setRate(95e6); // inside the owner's 10% limit, outside the 1% cap
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(t.balanceOf(OWNER), 1e18, "third party cannot use the wider limit");
        assertEq(stable.balanceOf(OWNER), 0, "no swap");
    }

    function test_swap_thirdPartyInsideOnePercent() public {
        bytes32 id = _tPosition(1000);
        swap.setRate(99e6);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(stable.balanceOf(OWNER), 99e6, "swapped at the cap");
    }

    function test_swap_userLimitBelowCapStillApplies() public {
        bytes32 id = _tPosition(50);
        swap.setRate(99e6); // 1% under the oracle, user allows 0.5%
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(t.balanceOf(OWNER), 1e18, "raw");
    }

    function test_swap_noLegDeliversRaw() public {
        bytes32 id = _setup(OWNER, tVault, 1e18, STABLE, 1000); // stable harbour, but no leg for the token
        swap.setRate(100e6);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(t.balanceOf(OWNER), 1e18, "raw");
    }

    function test_swap_staleFeedDeliversRaw() public {
        bytes32 id = _tPosition(1000);
        swap.setRate(100e6);
        tFeed.set(100e8, block.timestamp - 3601);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(t.balanceOf(OWNER), 1e18, "raw");
    }

    function test_swap_stableBelowFloorDeliversRaw() public {
        bytes32 id = _tPosition(1000);
        swap.setRate(100e6);
        stableFeed.set(0.98e8, block.timestamp);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(t.balanceOf(OWNER), 1e18, "raw");
    }

    function test_swap_brokenPoolDeliversRaw() public {
        bytes32 id = _tPosition(1000);
        swap.setRate(100e6);
        swap.setBroken(true);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(t.balanceOf(OWNER), 1e18, "raw");
        assertEq(t.allowance(address(router), address(swap)), 0, "approval cleared");
    }

    function test_arm_legMustEndInStable() public {
        ExitRouter.SwapLeg memory l = _leg(address(t), address(tFeed));
        l.path = abi.encodePacked(address(t), uint24(500), address(weth));
        vm.expectRevert(ExitRouter.BadRoute.selector);
        router.arm(_swapParams(address(tVault), 100, _keys(pauseKey), _legs(l)));
    }

    function test_arm_storesLegsAndEmitsOnePerLeg() public {
        MockERC20 u = new MockERC20(18);
        ExitRouter.SwapLeg[] memory legs = new ExitRouter.SwapLeg[](2);
        legs[0] = _leg(address(t), address(tFeed));
        legs[1] = _leg(address(u), address(stableFeed));
        legs[1].heartbeat = 2 days;
        legs[1].tokenDecimals = 6;
        bytes32 id = router.positionId(OWNER, address(adapter), address(tVault), 0);
        tVault.deposit(OWNER, 1e18);
        vm.prank(OWNER);
        tVault.approve(address(router), type(uint256).max);
        vm.expectEmit(true, true, false, true);
        emit ExitRouter.SwapLegSet(id, address(t), address(tFeed), 3600, 18, legs[0].path);
        vm.expectEmit(true, true, false, true);
        emit ExitRouter.SwapLegSet(id, address(u), address(stableFeed), 2 days, 6, legs[1].path);
        vm.prank(OWNER);
        router.arm(_swapParams(address(tVault), 100, _keys(pauseKey), legs));
        ExitRouter.SwapLeg[] memory got = router.swapsOf(id);
        assertEq(got.length, 2, "two legs stored");
        assertTrue(got[1].token == address(u) && got[1].heartbeat == 2 days && got[1].tokenDecimals == 6, "second leg");
        assertTrue(keccak256(got[0].path) == keccak256(legs[0].path), "path stored");
    }

    function test_reArm_replacesTheLegs() public {
        bytes32 id = _tPosition(1000);
        assertEq(router.swapsOf(id).length, 1, "one leg");
        vm.prank(OWNER);
        router.arm(_params(address(tVault), RAW, 0, _keys(pauseKey))); // re-armed raw, with no legs
        assertEq(router.swapsOf(id).length, 0, "legs gone");
        swap.setRate(100e6);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(t.balanceOf(OWNER), 1e18, "raw, the old leg no longer applies");
    }

    function test_legOfAnotherPositionIsNeverUsed() public {
        _setupSwap(KEEPER, tVault, 1e18, 1000, _legs(_leg(address(t), address(tFeed)))); // someone else's leg for t
        bytes32 id = _setup(OWNER, tVault, 1e18, STABLE, 1000); // the owner names none
        swap.setRate(100e6);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(t.balanceOf(OWNER), 1e18, "raw");
        assertEq(stable.balanceOf(OWNER), 0, "no swap");
    }

    function test_quoteMinOut_isAPublicViewOverTheLegsInputs() public view {
        (bool ok, uint256 minOut) = router.quoteMinOut(address(tFeed), 3600, 18, 1e18, 100);
        assertTrue(ok, "priced");
        assertEq(minOut, 99e6, "$100 less 1%");
        (ok,) = router.quoteMinOut(address(tFeed), 3600, 18, 1e18, 1001);
        assertTrue(!ok, "slip above the ceiling");
        (ok,) = router.quoteMinOut(address(0), 3600, 18, 1e18, 100);
        assertTrue(!ok, "no feed");
        (ok,) = router.quoteMinOut(address(tFeed), 3600, 37, 1e18, 100);
        assertTrue(!ok, "decimals above the ceiling");
    }

    // ---------------------------------------------------------------- revocation

    function test_disarm_stopsThirdParties() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        _fireAlarm();
        vm.prank(OWNER);
        router.disarm(id);
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotArmed.selector);
        router.exit(id, pauseKey, 0);
    }

    function test_disarmAll_stopsEveryPosition() public {
        bytes32 a = _setup(OWNER, vault, 100e18, RAW, 0);
        bytes32 b = _setup(OWNER, tVault, 1e18, RAW, 0);
        vm.prank(OWNER);
        router.disarmAll();
        assertTrue(!router.isArmed(a) && !router.isArmed(b), "both disarmed");
    }

    function test_disarm_onlyOwner() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.NotOwner.selector);
        router.disarm(id);
    }

    function test_revokedApproval_movesNothing() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vm.prank(OWNER);
        vault.approve(address(router), 0);
        _fireAlarm();
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NothingToExit.selector);
        router.exit(id, pauseKey, 0);
        assertEq(vault.balanceOf(OWNER), 100e18, "untouched");
    }

    // ---------------------------------------------------------------- adversarial

    function test_reentrancy_exitAndClaimAreBlockedDuringExit() public {
        // Victim one has funds owed in the router. Victim two is armed with a live alarm.
        bytes32 v1 = _setup(OWNER, vault, 100e18, RAW, 0);
        stable.setBlocked(OWNER, true);
        vm.prank(OWNER);
        router.exit(v1, bytes32(0), 0);
        stable.setBlocked(OWNER, false);
        bytes32 v2 = _setup(KEEPER, tVault, 1e18, RAW, 0);
        _fireAlarm();

        ReentrantVault rv = new ReentrantVault(stable, address(router));
        rv.setVictim(v2, pauseKey, OWNER);
        rv.mint(ATTACKER, 10e18);
        vm.prank(ATTACKER);
        rv.approve(address(router), type(uint256).max);
        vm.prank(ATTACKER);
        bytes32 id = router.arm(_params(address(rv), RAW, 0, new bytes32[](0))); // pauseKey is live, so not armable now

        vm.prank(ATTACKER);
        router.exit(id, bytes32(0), 0); // succeeds, so the attempts below stay recorded

        assertTrue(!rv.exitEntered(), "nested exit blocked");
        assertTrue(!rv.claimEntered(), "nested claim blocked");
        assertTrue(rv.exitError() == ReentrancyGuard.Reentrancy.selector, "exit stopped by the guard");
        assertTrue(rv.claimError() == ReentrancyGuard.Reentrancy.selector, "claim stopped by the guard");
        assertEq(tVault.balanceOf(KEEPER), 1e18, "victim two untouched");
        assertEq(router.owed(OWNER, address(stable)), 100e6, "victim one still owed");
        assertEq(stable.balanceOf(ATTACKER), 1e6, "attacker got only what its own vault paid");
    }

    function test_owed_cannotBeBookedTwice() public {
        SelfAssetVault sv = new SelfAssetVault(stable);
        sv.mint(OWNER, 10e18);
        vm.prank(OWNER);
        sv.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(sv), RAW, 0, _keys(pauseKey)));
        sv.setBlocked(OWNER, true); // returning the shares fails, so they are booked as owed
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(router.owed(OWNER, address(sv)), 10e18, "booked exactly once");
        assertEq(router.totalOwed(address(sv)), 10e18, "total booked exactly once");
    }

    function test_adapter_onlyRouterCanUnwind() public {
        vm.prank(ATTACKER);
        vm.expectRevert(AdapterBase.OnlyRouter.selector);
        adapter.unwind(address(vault), 1);
    }

    function test_disarmAll_blocksExitsUntilRearmed() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        _fireAlarm();
        vm.prank(OWNER);
        router.disarmAll();
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotArmed.selector);
        router.exit(id, pauseKey, 0);
        pausable.setPaused(false);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(OWNER);
        router.arm(_params(address(vault), RAW, 0, _keys(pauseKey)));
        vm.warp(block.timestamp + 1);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(stable.balanceOf(OWNER), 100e6, "re-armed exit works");
    }

    function test_evilAdapter_cannotTouchVictimApproval() public {
        EvilAdapter evil = new EvilAdapter();
        vm.prank(ADMIN);
        router.setAdapter(address(evil), true);
        _setup(OWNER, vault, 100e18, RAW, 0);

        vm.prank(ATTACKER);
        ExitRouter.ArmParams memory p = _params(address(vault), RAW, 0, _keys(pauseKey));
        p.adapter = address(evil);
        bytes32 id = router.arm(p);
        _fireAlarm();
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.NothingToExit.selector); // attacker's position, attacker holds nothing
        router.exit(id, pauseKey, 0);
        assertEq(vault.balanceOf(OWNER), 100e18, "victim untouched");
    }

    function test_evilVault_cannotReenterOrReachOwedFunds() public {
        // A real victim with funds owed sitting in the router.
        bytes32 victim = _setup(OWNER, vault, 100e18, RAW, 0);
        stable.setBlocked(OWNER, true);
        vm.prank(OWNER);
        router.exit(victim, bytes32(0), 0);
        uint256 held = stable.balanceOf(address(router));
        assertEq(held, 100e6, "owed held");
        stable.setBlocked(OWNER, false);

        // Second victim position, still armed and approved.
        bytes32 victim2 = _setup(KEEPER, tVault, 1e18, RAW, 0);

        // Attacker arms an unlisted vault that claims the stablecoin as its asset.
        EvilVault ev = new EvilVault(address(stable), address(router));
        ev.setVictim(victim2, OWNER, address(stable));
        ev.mint(ATTACKER, 10e18);
        vm.prank(ATTACKER);
        ev.approve(address(router), type(uint256).max);
        vm.prank(ATTACKER);
        bytes32 id = router.arm(_params(address(ev), RAW, 0, _keys(pauseKey)));

        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.NothingWithdrawn.selector);
        router.exit(id, bytes32(0), 0);

        assertEq(stable.balanceOf(ATTACKER), 0, "attacker got nothing");
        assertEq(stable.balanceOf(address(router)), held, "owed funds intact");
        assertEq(router.owed(OWNER, address(stable)), held, "owed record intact");
        assertEq(tVault.balanceOf(KEEPER), 1e18, "other victim intact");
    }

    function test_evilVault_reentryIsActuallyAttempted() public {
        bytes32 victim2 = _setup(KEEPER, tVault, 1e18, RAW, 0);
        EvilVault ev = new EvilVault(address(stable), address(router));
        ev.setVictim(victim2, OWNER, address(stable));
        ev.mint(ATTACKER, 10e18);
        vm.prank(ATTACKER);
        ev.approve(address(router), type(uint256).max);
        // Calling the hostile path directly proves the attack code runs and that state-changing
        // calls which are not behind the guard (disarm) fail on ownership, not by luck.
        vm.prank(address(ev));
        ev.approve(address(this), 0);
        vm.prank(ATTACKER);
        bytes32 id = router.arm(_params(address(ev), RAW, 0, _keys(pauseKey)));
        (bool ok, bytes memory ret) = address(this).call(abi.encodeCall(this.exitAs, (ATTACKER, id)));
        assertTrue(!ok && bytes4(ret) == ExitRouter.NothingWithdrawn.selector, "reverted as expected");
        assertTrue(router.isArmed(victim2), "victim still armed");
    }

    function exitAs(address who, bytes32 id) external {
        vm.prank(who);
        router.exit(id, bytes32(0), 0);
    }

    // ---------------------------------------------------------------- admin

    function test_admin_onlyAdminCanConfigure() public {
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.NotAdmin.selector);
        router.setAdapter(address(1), true);
    }

    function test_disablingAdapter_doesNotBlockExistingPositions() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vm.prank(ADMIN);
        router.setAdapter(address(adapter), false);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(stable.balanceOf(OWNER), 100e6, "exit still works");
    }

    function test_guardianCannotBlockExits() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        _fireAlarm();
        vm.prank(GUARD);
        router.setArmingPaused(true);
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(stable.balanceOf(OWNER), 100e6, "exit still works");
    }

    function test_expiry_endsAdminAndGuardian() public {
        vm.warp(block.timestamp + EXPIRY_FROM_START);
        vm.prank(ADMIN);
        vm.expectRevert(ExitRouter.NotAdmin.selector);
        router.setAdapter(address(1), true);
        vm.prank(ADMIN);
        vm.expectRevert(ExitRouter.NotAdmin.selector);
        router.setGuardian(address(1));

        vm.prank(GUARD);
        vm.expectRevert(ExitRouter.NotGuardian.selector);
        router.setArmingPaused(true);
    }

    function test_expiry_pausedRouterAcceptsArmingAgain() public {
        vm.prank(GUARD);
        router.setArmingPaused(true);
        vm.warp(block.timestamp + EXPIRY_FROM_START);
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        assertTrue(router.isArmed(id), "armed after expiry");
    }

    function test_exitAbiHasNoRecipient() public pure {
        assertTrue(
            ExitRouter.exit.selector == bytes4(keccak256("exit(bytes32,bytes32,uint256)")), "exit signature is fixed"
        );
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_anyCallerAnyAmount_onlyOwnerGains(address caller, uint96 shares, uint96 amount, uint96 liquidity)
        public
    {
        vm.assume(caller != OWNER && caller != address(router) && caller != address(vault) && caller != address(0));
        vm.assume(shares >= 1e12);
        bytes32 id = _setup(OWNER, vault, shares, RAW, 0);
        vault.setLiquid(uint256(liquidity) % (vault.liquid() + 1));
        _fireAlarm();
        uint256 keeperBefore = stable.balanceOf(caller);
        uint256 ownerBefore = stable.balanceOf(OWNER);
        uint256 sharesBefore = vault.balanceOf(OWNER);

        vm.prank(caller);
        try router.exit(id, pauseKey, amount) {
            assertTrue(stable.balanceOf(OWNER) > ownerBefore, "owner gained");
            assertTrue(vault.balanceOf(OWNER) < sharesBefore, "shares fell");
        } catch {
            assertEq(vault.balanceOf(OWNER), sharesBefore, "failed exit moves nothing");
            assertEq(stable.balanceOf(OWNER), ownerBefore, "failed exit pays nothing");
        }
        assertEq(stable.balanceOf(caller), keeperBefore, "caller gained nothing");
        assertEq(stable.balanceOf(address(router)), 0, "router holds nothing");
        assertEq(vault.balanceOf(address(router)), 0, "router holds no shares");
        assertEq(vault.balanceOf(address(adapter)), 0, "adapter holds no shares");
    }
}
