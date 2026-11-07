// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {AdapterBase} from "../src/adapters/AdapterBase.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {MockERC20, MockFeed} from "./Mocks.sol";
import {MockPositionManager, FeeOnTransferToken, CallbackToken} from "./MocksUniswapV3.sol";
import {INonfungiblePositionManager} from "../src/interfaces/IUniswapV3.sol";
import {DeployUniswapV3Adapter} from "../script/DeployUniswapV3Adapter.s.sol";

interface ChainVm {
    function chainId(uint256) external;
}

contract UniswapV3AdapterTest is Base {
    uint8 internal constant RAW = 0;
    uint8 internal constant STABLE = 1;

    MockPositionManager internal npm;
    UniswapV3Adapter internal v3;
    MockERC20 internal t0;
    MockFeed internal t0Feed;

    function setUp() public override {
        super.setUp();
        npm = new MockPositionManager();
        v3 = new UniswapV3Adapter(address(router), address(npm));
        t0 = new MockERC20(18);
        t0Feed = new MockFeed(100e8); // $100
        vm.startPrank(ADMIN);
        router.setAdapter(address(v3), true);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Mints a position of `a0` t0 and `a1` stable to `who`, approves the router for that NFT and arms it.
    function _lp(address who, uint256 a0, uint256 a1, uint128 liquidity, uint8 harbour, uint16 slip)
        internal
        returns (bytes32 posId, uint256 id)
    {
        id = npm.mint(who, t0, stable, liquidity, a0, a1);
        posId = _armNft(who, id, harbour, slip);
    }

    function _armNft(address who, uint256 id, uint8 harbour, uint16 slip) internal returns (bytes32 posId) {
        vm.prank(who);
        npm.approve(address(router), id);
        vm.prank(who);
        posId = router.arm(_nftParams(address(v3), id, harbour, slip));
    }

    function _nftParams(address a, uint256 id, uint8 harbour, uint16 slip)
        internal
        view
        returns (ExitRouter.ArmParams memory)
    {
        return ExitRouter.ArmParams({
            adapter: a,
            target: address(npm),
            tokenId: id,
            harbour: harbour,
            maxSlipBps: slip,
            termsHash: TERMS,
            keys: _keys(pauseKey),
            swaps: _lpSwaps(harbour)
        });
    }

    function _lpSwaps(uint8 harbour) internal view returns (ExitRouter.SwapLeg[] memory legs) {
        legs = new ExitRouter.SwapLeg[](harbour == STABLE ? 1 : 0);
        if (legs.length != 0) legs[0] = ExitRouter.SwapLeg(address(t0), address(t0Feed), 3600, 18, abi.encodePacked(address(t0), uint24(500), address(stable)));
    }

    function _liquidity(uint256 id) internal view returns (uint128) {
        return npm.positions(id).liquidity;
    }

    function _owed(uint256 id) internal view returns (uint128, uint128) {
        INonfungiblePositionManager.Position memory p = npm.positions(id);
        return (p.tokensOwed0, p.tokensOwed1);
    }

    function _assertNothingLeftBehind(MockERC20 a, MockERC20 b) internal view {
        assertEq(a.balanceOf(address(router)), 0, "router residue a");
        assertEq(b.balanceOf(address(router)), 0, "router residue b");
        assertEq(a.balanceOf(address(v3)), 0, "adapter residue a");
        assertEq(b.balanceOf(address(v3)), 0, "adapter residue b");
    }

    // ---------------------------------------------------------------- views

    function test_views_pinnedToOnePositionManager() public {
        (address asset, bool isNft) = v3.positionAsset(address(npm));
        assertTrue(asset == address(npm) && isNft, "asset");
        (, uint256 id) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        address[] memory outs = v3.outputs(address(npm), id);
        assertTrue(outs.length == 2 && outs[0] == address(t0) && outs[1] == address(stable), "outputs");
        vm.expectRevert(UniswapV3Adapter.WrongTarget.selector);
        v3.positionAsset(address(0x1234));
        vm.expectRevert(UniswapV3Adapter.WrongTarget.selector);
        v3.outputs(address(0x1234), id);
    }

    function test_arm_rejectsOtherPositionManager() public {
        MockPositionManager other = new MockPositionManager();
        uint256 id = other.mint(OWNER, t0, stable, 1000, 1e18, 100e6);
        ExitRouter.ArmParams memory p = _nftParams(address(v3), id, RAW, 0);
        p.target = address(other);
        vm.prank(OWNER);
        vm.expectRevert(UniswapV3Adapter.WrongTarget.selector);
        router.arm(p);
    }

    // ---------------------------------------------------------------- exits

    function test_ownerExitNow_principalAndFees() public {
        (bytes32 id, uint256 tid) = _lp(OWNER, 2e18, 300e6, 1000, RAW, 0);
        npm.addFees(tid, 0.01e18, 1e6);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(t0.balanceOf(OWNER), 2.01e18, "token0 principal + fees");
        assertEq(stable.balanceOf(OWNER), 301e6, "token1 principal + fees");
        assertTrue(npm.ownerOf(tid) == OWNER, "emptied NFT back with the owner");
        assertEq(_liquidity(tid), 0, "no liquidity left");
        (uint128 o0, uint128 o1) = _owed(tid);
        assertEq(o0 + o1, 0, "nothing owed left");
        _assertNothingLeftBehind(t0, stable);
    }

    function test_ownerExit_worksUnarmedAndAfterDisarm() public {
        (bytes32 id,) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        vm.prank(OWNER);
        router.disarm(id);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(t0.balanceOf(OWNER), 1e18, "owner paid");
    }

    function test_keeperExit_paysOnlyOwner() public {
        (bytes32 id, uint256 tid) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(t0.balanceOf(OWNER), 1e18, "owner token0");
        assertEq(stable.balanceOf(OWNER), 100e6, "owner token1");
        assertEq(t0.balanceOf(KEEPER) + stable.balanceOf(KEEPER), 0, "keeper got nothing");
        assertTrue(npm.ownerOf(tid) == OWNER, "NFT with the owner, not the keeper");
        _assertNothingLeftBehind(t0, stable);
    }

    function test_keeperExit_rejectedAfterDisarm() public {
        (bytes32 id, uint256 tid) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        _fireAlarm();
        vm.prank(OWNER);
        router.disarm(id);
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotArmed.selector);
        router.exit(id, pauseKey, 0);
        assertEq(_liquidity(tid), 1000, "position untouched");
    }

    function test_keeperExit_rejectedAfterDisarmAll() public {
        (bytes32 id,) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        _fireAlarm();
        vm.prank(OWNER);
        router.disarmAll();
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotArmed.selector);
        router.exit(id, pauseKey, 0);
    }

    function test_keeperExit_rejectedWithNoAlarm() public {
        (bytes32 id,) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, pauseKey, 0);
    }

    function test_outOfRange_singleToken() public {
        (bytes32 id, uint256 tid) = _lp(OWNER, 5e18, 0, 1000, RAW, 0);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(t0.balanceOf(OWNER), 5e18, "all token0");
        assertEq(stable.balanceOf(OWNER), 0, "no token1");
        assertEq(_liquidity(tid), 0, "emptied");
    }

    function test_zeroLiquidity_collectsFeesOwed() public {
        (bytes32 id, uint256 tid) = _lp(OWNER, 0, 0, 0, RAW, 0);
        npm.addFees(tid, 0.5e18, 7e6);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(t0.balanceOf(OWNER), 0.5e18, "fees token0");
        assertEq(stable.balanceOf(OWNER), 7e6, "fees token1");
    }

    function test_emptyPosition_revertsAndNftStays() public {
        (bytes32 id, uint256 tid) = _lp(OWNER, 0, 0, 0, RAW, 0);
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.NothingWithdrawn.selector);
        router.exit(id, bytes32(0), 0);
        assertTrue(npm.ownerOf(tid) == OWNER, "NFT never left");
    }

    function test_harbourStable_swapsToken0AndPaysStableOnce() public {
        swap.setRate(100e6); // $100 per token0, the oracle price
        (bytes32 id,) = _lp(OWNER, 1e18, 50e6, 1000, STABLE, 50);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(t0.balanceOf(OWNER), 0, "token0 swapped");
        assertEq(stable.balanceOf(OWNER), 150e6, "swap proceeds plus token1");
        _assertNothingLeftBehind(t0, stable);
    }

    function test_harbourStable_thirdPartySwapBoundedByOracle() public {
        swap.setRate(98e6); // pool 2% under the oracle: a keeper may not accept that
        (bytes32 id,) = _lp(OWNER, 1e18, 50e6, 1000, STABLE, 500);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(t0.balanceOf(OWNER), 1e18, "token0 delivered raw instead");
        assertEq(stable.balanceOf(OWNER), 50e6, "token1");
    }

    function test_feeOnTransferToken_ownerGetsWhatArrived() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        uint256 tid = npm.mint(OWNER, fot, stable, 1000, 100e18, 10e6);
        bytes32 id = _armNft(OWNER, tid, RAW, 0);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(fot.balanceOf(OWNER), 98.01e18, "1% at the pool, 1% at the router");
        assertEq(stable.balanceOf(OWNER), 10e6, "token1");
        _assertNothingLeftBehind(fot, stable);
    }

    function test_blockedToken_otherTokenStillLeaves() public {
        (bytes32 id, uint256 tid) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        stable.setBlocked(address(router), true); // token1 can't reach the router
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(t0.balanceOf(OWNER), 1e18, "token0 delivered");
        assertTrue(npm.ownerOf(tid) == OWNER, "NFT back with the owner");
        (uint128 o0, uint128 o1) = _owed(tid);
        assertEq(o0, 0, "token0 collected");
        assertEq(o1, 100e6, "token1 still owed inside the NFT");
        // Owner collects it later, directly.
        vm.prank(OWNER);
        npm.collect(MockPositionManager.CollectParams(tid, OWNER, type(uint128).max, type(uint128).max));
        assertEq(stable.balanceOf(OWNER), 100e6, "owner collects the rest");
    }

    function test_bothTokensBlocked_revertsWithNothingMoved() public {
        (bytes32 id, uint256 tid) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        stable.setBlocked(address(router), true);
        t0.setBlocked(address(router), true);
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.NothingWithdrawn.selector);
        router.exit(id, bytes32(0), 0);
        assertEq(_liquidity(tid), 1000, "liquidity untouched");
        assertTrue(npm.ownerOf(tid) == OWNER, "NFT never left");
    }

    function test_starvedCollect_revertsWholeExit() public {
        (bytes32 id, uint256 tid) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        _fireAlarm();
        npm.setBurnGas(true);
        vm.prank(KEEPER);
        vm.expectRevert(UniswapV3Adapter.OutOfGas.selector);
        router.exit{gas: 3_000_000}(id, pauseKey, 0);
        assertEq(_liquidity(tid), 1000, "liquidity untouched");
    }

    // ---------------------------------------------------------------- attacks

    function test_attack_cannotArmSomeoneElsesNft() public {
        uint256 tid = npm.mint(OWNER, t0, stable, 1000, 1e18, 100e6);
        vm.prank(OWNER);
        npm.setApprovalForAll(address(router), true);
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.NotOwner.selector);
        router.arm(_nftParams(address(v3), tid, RAW, 0));
    }

    function test_attack_strangerCannotExitWithoutLiveAlarm() public {
        (bytes32 id,) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, pauseKey, 0);
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.NotAuthorized.selector);
        router.exit(id, keccak256("other"), 0);
    }

    function test_attack_nftSoldAfterArming_cannotBePulledFromBuyer() public {
        (bytes32 id, uint256 tid) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        address buyer = address(0xB1);
        vm.prank(OWNER);
        npm.transferFrom(OWNER, buyer, tid);
        vm.prank(buyer);
        npm.setApprovalForAll(address(router), true);
        _fireAlarm();
        vm.prank(KEEPER);
        vm.expectRevert(bytes("wrong from"));
        router.exit(id, pauseKey, 0);
        assertTrue(npm.ownerOf(tid) == buyer, "buyer keeps it");
    }

    function test_attack_unlistedAdapterRejected() public {
        UniswapV3Adapter rogue = new UniswapV3Adapter(address(router), address(npm));
        uint256 tid = npm.mint(OWNER, t0, stable, 1000, 1e18, 100e6);
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.NotSupported.selector);
        router.arm(_nftParams(address(rogue), tid, RAW, 0));
    }

    function test_attack_onlyRouterCanUnwind() public {
        uint256 tid = npm.mint(address(v3), t0, stable, 1000, 1e18, 100e6); // even an NFT sitting in the adapter
        vm.prank(ATTACKER);
        vm.expectRevert(AdapterBase.OnlyRouter.selector);
        v3.unwind(address(npm), tid);
    }

    function test_attack_revokedApproval_movesNothing() public {
        (bytes32 id, uint256 tid) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        vm.prank(OWNER);
        npm.approve(address(0), tid);
        _fireAlarm();
        vm.prank(KEEPER);
        vm.expectRevert(bytes("not approved"));
        router.exit(id, pauseKey, 0);
        assertEq(_liquidity(tid), 1000, "untouched");
    }

    function test_attack_reentryFromTokenCallbackGoesNowhere() public {
        CallbackToken evil = new CallbackToken();
        uint256 victimTid = npm.mint(OWNER, t0, stable, 1000, 1e18, 100e6);
        bytes32 victim = _armNft(OWNER, victimTid, RAW, 0);
        uint256 tid = npm.mint(ATTACKER, evil, stable, 1000, 1e18, 100e6);
        bytes32 own = _armNft(ATTACKER, tid, RAW, 0);
        _fireAlarm();
        evil.arm(address(router), address(v3), address(npm), victim, pauseKey, OWNER, tid);
        vm.prank(ATTACKER);
        router.exit(own, bytes32(0), 0);
        assertEq(evil.attempts(), 5, "every reentry tried");
        assertEq(evil.successes(), 0, "none got through");
        assertEq(_liquidity(victimTid), 1000, "victim untouched");
        assertEq(evil.balanceOf(ATTACKER), 1e18, "attacker's own exit still completes");
        assertTrue(npm.ownerOf(tid) == ATTACKER, "NFT back");
    }

    function test_approvalIsSpentByTheExit() public {
        (bytes32 id, uint256 tid) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertTrue(npm.getApproved(tid) == address(0), "single-token approval cleared by the transfer");
    }

    function test_disabledAdapter_armedPositionStillExits() public {
        (bytes32 id,) = _lp(OWNER, 1e18, 100e6, 1000, RAW, 0);
        vm.prank(ADMIN);
        router.setAdapter(address(v3), false);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(id, pauseKey, 0);
        assertEq(t0.balanceOf(OWNER), 1e18, "owner paid");
    }

    // ---------------------------------------------------------------- deploy script

    function test_deployScript_deploysDisabledAndWired() public {
        DeployUniswapV3Adapter s = new DeployUniswapV3Adapter();
        npm.setWETH9(address(weth));
        s.validate(address(router), address(npm));
        UniswapV3Adapter a = s.deploy(address(router), address(npm));
        s.check(address(router), address(npm), a);
        assertTrue(!router.adapterAllowed(address(a)), "starts disabled");
    }

    function test_deployScript_refusesUnsafeSettings() public {
        DeployUniswapV3Adapter s = new DeployUniswapV3Adapter();
        vm.expectRevert(abi.encodeWithSelector(DeployUniswapV3Adapter.NoCode.selector, "router"));
        s.validate(address(0x1234), address(npm));
        vm.expectRevert(DeployUniswapV3Adapter.WrongPositionManager.selector); // WETH9 unset: not this router's chain
        s.validate(address(router), address(npm));
        npm.setWETH9(address(weth));
        vm.warp(router.ADMIN_EXPIRY());
        vm.expectRevert(DeployUniswapV3Adapter.AdminExpired.selector);
        s.validate(address(router), address(npm));
    }

    function test_deployScript_mainnetOnlyTakesTheCanonicalPositionManager() public {
        DeployUniswapV3Adapter s = new DeployUniswapV3Adapter();
        npm.setWETH9(address(weth));
        ChainVm(address(vm)).chainId(4663);
        vm.expectRevert(DeployUniswapV3Adapter.WrongPositionManager.selector);
        s.validate(address(router), address(npm));
        assertTrue(s.positionsFor(8453) == s.BASE_POSITIONS(), "base pinned");
        assertTrue(s.positionsFor(1) == address(0), "others unpinned");
    }

    function testFuzz_exitPaysExactlyWhatThePositionHeld(uint96 a0, uint96 a1, uint96 f0, uint96 f1, uint128 l) public {
        if (l == 0) (a0, a1) = (0, 0);
        vm.assume(uint256(a0) + a1 + f0 + f1 > 0);
        uint256 tid = npm.mint(OWNER, t0, stable, l, a0, a1);
        npm.addFees(tid, f0, f1);
        bytes32 id = _armNft(OWNER, tid, RAW, 0);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(t0.balanceOf(OWNER), uint256(a0) + f0, "token0");
        assertEq(stable.balanceOf(OWNER), uint256(a1) + f1, "token1");
        _assertNothingLeftBehind(t0, stable);
    }
}
