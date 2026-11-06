// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {Timelock} from "../src/Timelock.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {AdapterBase} from "../src/adapters/AdapterBase.sol";
import {IExitAdapter} from "../src/interfaces/IExitAdapter.sol";
import {SafeTransferLib} from "../src/lib/SafeTransferLib.sol";
import {ReentrancyGuard} from "../src/lib/ReentrancyGuard.sol";
import {MockERC20, MockVault, MockFeed, ReentrantVault, MockPausable} from "./Mocks.sol";

// Negative tests: one test per revert path of every state-changing external function in contracts/src.
//
// Every custom error declared in contracts/src is thrown by at least one test below (v2 removed the two that v1
// declared and never threw: AdapterBase.WrongTarget and SafeTransferLib.ApproveFailed).
//
// Each failing call is paired with a nearby call that succeeds where that makes the boundary clear, so a
// test cannot pass just because the setup is broken.

// ------------------------------------------------------------------------------------------ helpers

/// @dev A minimal ERC-721 with per-token approval and operator approval.
contract MockNft {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function setApprovalForAll(address op, bool ok) external {
        isApprovedForAll[msg.sender][op] = ok;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "not owner");
        require(msg.sender == from || isApprovedForAll[from][msg.sender] || getApproved[id] == msg.sender, "not approved");
        ownerOf[id] = to;
    }
}

/// @dev An NFT adapter. `returnNft` decides whether unwind gives the NFT back, `payout` how much stable it mints to the router.
contract MockNftAdapter is IExitAdapter {
    MockNft public immutable nft;
    MockERC20 public immutable stable;
    bool public returnNft;
    uint256 public payout;

    constructor(MockNft n, MockERC20 s) {
        nft = n;
        stable = s;
    }

    function set(bool r, uint256 p) external {
        returnNft = r;
        payout = p;
    }

    function positionAsset(address) external view returns (address, bool) {
        return (address(nft), true);
    }

    function outputs(address, uint256) external pure returns (address[] memory t) {
        t = new address[](0);
    }

    function unwind(address, uint256 id) external {
        if (returnNft) nft.transferFrom(address(this), msg.sender, id);
        if (payout > 0) stable.mint(msg.sender, payout);
    }
}

/// @dev Adapter that pays native ETH to whoever calls unwind.
contract MockEthAdapter is IExitAdapter {
    function positionAsset(address target) external pure returns (address, bool) {
        return (target, false);
    }

    function outputs(address, uint256) external pure returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(0);
    }

    function unwind(address, uint256) external {
        (bool ok,) = msg.sender.call{value: address(this).balance}("");
        require(ok, "send");
    }

    receive() external payable {}
}

/// @dev A position owner that is a contract and refuses ETH until told otherwise.
contract EthRejector {
    bool public accept;

    receive() external payable {
        require(accept, "no eth");
    }

    function setAccept(bool a) external {
        accept = a;
    }

    function run(address to, bytes calldata data) external {
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}

/// @dev A smart-contract watcher whose ERC-1271 check always says no.
contract RefusingWallet {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }
}

/// @dev A vault that answers like a real one until told to burn every unit of gas on every read.
contract SwitchVault {
    bool public burn;
    uint256 public price = 1e6;

    function setBurn(bool b) external {
        burn = b;
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function decimals() external view returns (uint8) {
        _maybeBurn();
        return 18;
    }

    function convertToAssets(uint256) external view returns (uint256) {
        _maybeBurn();
        return price;
    }

    function totalAssets() external view returns (uint256) {
        _maybeBurn();
        return price * 1000;
    }

    function _maybeBurn() internal view {
        if (burn) {
            assembly {
                invalid()
            }
        }
    }
}

// ------------------------------------------------------------------------------------------ ExitRouter

contract ExitRouterReverts is Base {
    uint8 internal constant RAW = 0;
    uint8 internal constant STABLE = 1;
    MockNft internal nft;
    MockNftAdapter internal nftAdapter;

    function setUp() public override {
        super.setUp();
        nft = new MockNft();
        nftAdapter = new MockNftAdapter(nft, stable);
        vm.prank(ADMIN);
        router.setAdapter(address(nftAdapter), true);
        nft.mint(OWNER, 7);
    }

    function _nftParams() internal view returns (ExitRouter.ArmParams memory) {
        return ExitRouter.ArmParams({
            adapter: address(nftAdapter),
            target: address(nft),
            tokenId: 7,
            harbour: RAW,
            maxSlipBps: 0,
            termsHash: TERMS,
            keys: _keys(pauseKey),
            swaps: new ExitRouter.SwapLeg[](0)
        });
    }

    function _armNft() internal returns (bytes32 id) {
        vm.prank(OWNER);
        nft.setApprovalForAll(address(router), true);
        vm.prank(OWNER);
        id = router.arm(_nftParams());
    }

    // ---------------------------------------------------------------- arm

    function test_arm_ArmingIsPaused() public {
        vm.prank(GUARD);
        router.setArmingPaused(true);
        ExitRouter.ArmParams memory p = _params(address(vault), RAW, 0, _keys(pauseKey));
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.ArmingIsPaused.selector);
        router.arm(p);
    }

    function test_arm_NotSupported_unlistedAdapter() public {
        ExitRouter.ArmParams memory p = _params(address(vault), RAW, 0, _keys(pauseKey));
        p.adapter = address(0xDEAD);
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.NotSupported.selector);
        router.arm(p);
    }

    function test_arm_NotSupported_afterAdapterDisabled() public {
        vm.prank(ADMIN);
        router.setAdapter(address(adapter), false);
        ExitRouter.ArmParams memory p = _params(address(vault), RAW, 0, _keys(pauseKey));
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.NotSupported.selector);
        router.arm(p);
    }

    function test_arm_BadHarbour() public {
        ExitRouter.ArmParams memory p = _params(address(vault), 2, 0, _keys(pauseKey));
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.BadHarbour.selector);
        router.arm(p);
        p.harbour = STABLE; // the highest valid value
        vm.prank(OWNER);
        router.arm(p);
    }

    function test_arm_SlipTooHigh() public {
        ExitRouter.ArmParams memory p = _params(address(vault), RAW, 1001, _keys(pauseKey));
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.SlipTooHigh.selector);
        router.arm(p);
        p.maxSlipBps = 1000; // exactly the cap
        vm.prank(OWNER);
        router.arm(p);
    }

    function test_arm_TooManyKeys() public {
        bytes32[] memory nine = new bytes32[](9);
        ExitRouter.ArmParams memory p = _params(address(vault), RAW, 0, nine);
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.TooManyKeys.selector);
        router.arm(p);
        p.keys = new bytes32[](8); // exactly MAX_KEYS, each a real, armable key
        for (uint256 i; i < 8; ++i) {
            p.keys[i] = book.register(_detector(AlarmBook.Kind.QUORUM, address(uint160(0x100 + i)), 2, 0, 0, 0));
        }
        vm.prank(OWNER);
        router.arm(p);
    }

    // ---------------------------------------------------------------- arm: only clear alarms (L-1, A2-01)

    function _expectNotClear(bytes32 key) internal {
        ExitRouter.ArmParams memory p = _params(address(vault), RAW, 0, _keys(key));
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.AlarmNotClear.selector, key));
        router.arm(p);
    }

    function test_arm_AlarmNotClear_unknownKey() public {
        _expectNotClear(keccak256("never registered"));
        _expectNotClear(bytes32(0));
    }

    function test_arm_AlarmNotClear_trippedKey() public {
        pausable.setPaused(true); // tripped, never fired
        _expectNotClear(pauseKey);
        pausable.setPaused(false);
        vm.prank(OWNER);
        router.arm(_params(address(vault), RAW, 0, _keys(pauseKey))); // clear: armable
    }

    function test_arm_AlarmNotClear_firedInTheLastDay() public {
        _fireAlarm();
        pausable.setPaused(false); // clear again, but it fired less than REFIRE_AFTER ago
        _expectNotClear(pauseKey);
        vm.warp(block.timestamp + 1 days);
        vm.prank(OWNER);
        router.arm(_params(address(vault), RAW, 0, _keys(pauseKey)));
    }

    function test_arm_AlarmNotClear_unreadableKeyFailsClosed() public {
        SwitchVault sv = new SwitchVault();
        bytes32 k = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(sv), 50, 0, 0, 0));
        sv.setBurn(true);
        _expectNotClear(k);
        sv.setBurn(false);
        vm.prank(OWNER);
        router.arm(_params(address(vault), RAW, 0, _keys(k)));
    }

    /// A bare DRAIN key is refused, alone or among good keys, whatever it reads; the same DRAIN inside BOTH with a QUORUM
    /// key is accepted.
    function test_arm_DrainNeedsQuorum() public {
        vault.deposit(OWNER, 100e18);
        bytes32 drain = book.register(_detector(AlarmBook.Kind.DRAIN, address(vault), 2500, 3600, 0, 0));
        assertTrue(book.armable(drain), "the DRAIN key itself reads armable");
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.DrainNeedsQuorum.selector, drain));
        router.arm(_params(address(vault), RAW, 0, _keys(drain)));
        bytes32[] memory ks = new bytes32[](2);
        ks[0] = pauseKey;
        ks[1] = drain;
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.DrainNeedsQuorum.selector, drain));
        router.arm(_params(address(vault), RAW, 0, ks));
        bytes32 q = book.register(_detector(AlarmBook.Kind.QUORUM, address(vault), 2, 0, 0, 0));
        bytes32 both = book.register(_detector(AlarmBook.Kind.BOTH, address(vault), 0, 1 days, drain, q));
        vm.prank(OWNER);
        router.arm(_params(address(vault), RAW, 0, _keys(both)));
    }

    /// A BOTH key that carries a DRAIN part without a QUORUM other part is refused, in either order, and so is
    /// BOTH(DRAIN, QUORUM) with any window but one day; the one-day BOTH(DRAIN, QUORUM) and a BOTH of two non-DRAIN keys
    /// (any window) are accepted.
    function test_arm_DrainNeedsQuorum_bothWithoutAQuorumPart() public {
        vault.deposit(OWNER, 100e18);
        bytes32 drain = book.register(_detector(AlarmBook.Kind.DRAIN, address(vault), 2500, 3600, 0, 0));
        bytes32 drain2 = book.register(_detector(AlarmBook.Kind.DRAIN, address(vault), 3000, 3600, 0, 0));
        bytes32 q = book.register(_detector(AlarmBook.Kind.QUORUM, address(vault), 2, 0, 0, 0));
        bytes32[3] memory bad = [
            book.register(_detector(AlarmBook.Kind.BOTH, address(vault), 0, 1 days, drain, pauseKey)),
            book.register(_detector(AlarmBook.Kind.BOTH, address(vault), 0, 1 days, pauseKey, drain)),
            book.register(_detector(AlarmBook.Kind.BOTH, address(vault), 0, 1 days, drain, drain2))
        ];
        for (uint256 i; i < 3; ++i) {
            vm.prank(OWNER);
            vm.expectRevert(abi.encodeWithSelector(ExitRouter.DrainNeedsQuorum.selector, bad[i]));
            router.arm(_params(address(vault), RAW, 0, _keys(bad[i])));
        }
        // V3C-01: with a DRAIN part the window must be exactly one day; a longer one is refused.
        bytes32 longWindow = book.register(_detector(AlarmBook.Kind.BOTH, address(vault), 0, 1 days + 1, drain, q));
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.DrainNeedsQuorum.selector, longWindow));
        router.arm(_params(address(vault), RAW, 0, _keys(longWindow)));
        bytes32 qFirst = book.register(_detector(AlarmBook.Kind.BOTH, address(vault), 0, 1 days, q, drain));
        // A BOTH without a DRAIN part may have any window AlarmBook allows.
        bytes32 noDrain = book.register(_detector(AlarmBook.Kind.BOTH, address(vault), 0, 7 days, pauseKey, q));
        bytes32[] memory ok = new bytes32[](2);
        ok[0] = qFirst;
        ok[1] = noDrain;
        vm.prank(OWNER);
        router.arm(_params(address(vault), RAW, 0, ok));
    }

    function test_arm_NestedBoth() public {
        bytes32 q = book.register(_detector(AlarmBook.Kind.QUORUM, address(vault), 2, 0, 0, 0));
        bytes32 inner = book.register(_detector(AlarmBook.Kind.BOTH, address(vault), 0, 1 days, pauseKey, q));
        bytes32[2] memory nested = [
            book.register(_detector(AlarmBook.Kind.BOTH, address(vault), 0, 1 days, inner, q)),
            book.register(_detector(AlarmBook.Kind.BOTH, address(vault), 0, 1 days, q, inner))
        ];
        for (uint256 i; i < 2; ++i) {
            vm.prank(OWNER);
            vm.expectRevert(abi.encodeWithSelector(ExitRouter.NestedBoth.selector, nested[i]));
            router.arm(_params(address(vault), RAW, 0, _keys(nested[i])));
        }
        vm.prank(OWNER);
        router.arm(_params(address(vault), RAW, 0, _keys(inner)));
    }

    function test_arm_AlarmNotClear_oneBadKeyAmongGoodOnes() public {
        bytes32 q = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xBEEF), 2, 0, 0, 0));
        bytes32[] memory ks = new bytes32[](2);
        ks[0] = q;
        ks[1] = keccak256("unknown");
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.AlarmNotClear.selector, ks[1]));
        router.arm(_params(address(vault), RAW, 0, ks));
    }

    // ---------------------------------------------------------------- arm: swap legs (M-1, A2-07)

    function _armLegs(ExitRouter.SwapLeg[] memory legs, uint8 harbour) internal {
        ExitRouter.ArmParams memory p = _params(address(vault), harbour, 100, _keys(pauseKey));
        p.swaps = legs;
        vm.prank(OWNER);
        router.arm(p);
    }

    function _expectLegs(ExitRouter.SwapLeg[] memory legs, uint8 harbour, bytes memory err) internal {
        ExitRouter.ArmParams memory p = _params(address(vault), harbour, 100, _keys(pauseKey));
        p.swaps = legs;
        vm.prank(OWNER);
        vm.expectRevert(err);
        router.arm(p);
    }

    function _wethLeg() internal view returns (ExitRouter.SwapLeg memory) {
        return _leg(address(weth), address(stableFeed));
    }

    function test_arm_SwapsNeedStableHarbour() public {
        ExitRouter.SwapLeg[] memory legs = _legs(_wethLeg());
        _expectLegs(legs, RAW, abi.encodeWithSelector(ExitRouter.SwapsNeedStableHarbour.selector));
        _armLegs(legs, STABLE);
    }

    function test_arm_TooManySwaps() public {
        ExitRouter.SwapLeg[] memory legs = new ExitRouter.SwapLeg[](5);
        for (uint256 i; i < 5; ++i) {
            legs[i] = _leg(address(new MockERC20(18)), address(stableFeed));
        }
        _expectLegs(legs, STABLE, abi.encodeWithSelector(ExitRouter.TooManySwaps.selector));
        ExitRouter.SwapLeg[] memory four = new ExitRouter.SwapLeg[](4);
        for (uint256 i; i < 4; ++i) {
            four[i] = legs[i];
        }
        _armLegs(four, STABLE); // exactly MAX_SWAPS
    }

    function test_arm_DuplicateSwap() public {
        ExitRouter.SwapLeg[] memory legs = new ExitRouter.SwapLeg[](3);
        legs[0] = _wethLeg();
        legs[1] = _leg(address(new MockERC20(18)), address(stableFeed));
        legs[2] = _wethLeg();
        _expectLegs(legs, STABLE, abi.encodeWithSelector(ExitRouter.DuplicateSwap.selector, address(weth)));
    }

    function test_arm_BadFeed_noCode() public {
        ExitRouter.SwapLeg memory l = _wethLeg();
        l.feed = address(0xFEED);
        _expectLegs(_legs(l), STABLE, abi.encodeWithSelector(ExitRouter.BadFeed.selector));
        l.feed = address(0);
        _expectLegs(_legs(l), STABLE, abi.encodeWithSelector(ExitRouter.BadFeed.selector));
    }

    function test_arm_BadFeed_heartbeatOutOfRange() public {
        ExitRouter.SwapLeg memory l = _wethLeg();
        l.heartbeat = 0;
        _expectLegs(_legs(l), STABLE, abi.encodeWithSelector(ExitRouter.BadFeed.selector));
        l.heartbeat = 2 days + 1;
        _expectLegs(_legs(l), STABLE, abi.encodeWithSelector(ExitRouter.BadFeed.selector));
        l.heartbeat = 2 days; // the highest allowed
        _armLegs(_legs(l), STABLE);
    }

    function test_arm_BadFeed_decimalsAboveMax() public {
        ExitRouter.SwapLeg memory l = _leg(address(new MockERC20(37)), address(stableFeed));
        l.tokenDecimals = 37;
        _expectLegs(_legs(l), STABLE, abi.encodeWithSelector(ExitRouter.BadFeed.selector));
        l = _leg(address(new MockERC20(36)), address(stableFeed));
        l.tokenDecimals = 36; // the highest allowed
        _armLegs(_legs(l), STABLE);
    }

    /// V3-03: the stated decimals must be the token's own `decimals()`, read with a gas cap; a token that can't say fails.
    function test_arm_BadFeed_decimalsDifferFromTheToken() public {
        ExitRouter.SwapLeg memory l = _wethLeg(); // an 18-decimal token
        l.tokenDecimals = 6;
        _expectLegs(_legs(l), STABLE, abi.encodeWithSelector(ExitRouter.BadFeed.selector));
        l.tokenDecimals = 24;
        _expectLegs(_legs(l), STABLE, abi.encodeWithSelector(ExitRouter.BadFeed.selector));
        ExitRouter.SwapLeg memory p = _leg(address(pausable), address(stableFeed)); // has code, no decimals()
        _expectLegs(_legs(p), STABLE, abi.encodeWithSelector(ExitRouter.BadFeed.selector));
        l.tokenDecimals = 18;
        _armLegs(_legs(l), STABLE);
    }

    function _badRoute(bytes memory path) internal {
        ExitRouter.SwapLeg memory l = _wethLeg();
        l.path = path;
        _expectLegs(_legs(l), STABLE, abi.encodeWithSelector(ExitRouter.BadRoute.selector));
    }

    function test_arm_BadRoute_empty() public {
        _badRoute("");
    }

    function test_arm_BadRoute_tooShort() public {
        _badRoute(abi.encodePacked(address(weth), uint16(500), address(stable))); // 42 bytes
    }

    function test_arm_BadRoute_misalignedLength() public {
        _badRoute(abi.encodePacked(address(weth), uint24(500), address(stable), uint8(1)));
    }

    function test_arm_BadRoute_startsAtAnotherToken() public {
        _badRoute(abi.encodePacked(address(stable), uint24(500), address(stable)));
    }

    function test_arm_BadRoute_endsAtAnotherToken() public {
        _badRoute(abi.encodePacked(address(weth), uint24(500), address(0xBEEF)));
    }

    function test_arm_validMultiHopPathIsAccepted() public {
        ExitRouter.SwapLeg memory l = _wethLeg();
        l.path = abi.encodePacked(address(weth), uint24(500), address(0xAA), uint24(100), address(stable));
        _armLegs(_legs(l), STABLE);
    }

    function test_arm_NotOwner_nftHeldBySomeoneElse() public {
        ExitRouter.ArmParams memory p = _nftParams();
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.NotOwner.selector);
        router.arm(p);
        vm.prank(OWNER);
        router.arm(p); // the real holder can
    }

    function test_arm_BadTokenId_erc20WithTokenId() public {
        ExitRouter.ArmParams memory p = _params(address(vault), RAW, 0, _keys(pauseKey));
        p.tokenId = 1;
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.BadTokenId.selector);
        router.arm(p);
    }

    // ---------------------------------------------------------------- disarm

    function test_disarm_NotOwner_stranger() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.NotOwner.selector);
        router.disarm(id);
        assertTrue(router.isArmed(id), "still armed");
    }

    function test_disarm_NotOwner_unknownPosition() public {
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.NotOwner.selector);
        router.disarm(keccak256("never armed"));
    }

    // ---------------------------------------------------------------- exit

    function test_exit_NotArmed_unknownPositionByStranger() public {
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotArmed.selector);
        router.exit(keccak256("never armed"), pauseKey, 0);
    }

    function test_exit_NotArmed_afterDisarm() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        _fireAlarm();
        vm.prank(OWNER);
        router.disarm(id);
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotArmed.selector);
        router.exit(id, pauseKey, 0);
    }

    function test_exit_NotArmed_afterDisarmAll() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        _fireAlarm();
        vm.prank(OWNER);
        router.disarmAll();
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotArmed.selector);
        router.exit(id, pauseKey, 0);
    }

    function test_exit_NotAuthorized_keyNotArmedForThisPosition() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        bytes32 other = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xBEEF), 2, 0, 0, 0));
        _fireAlarm();
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotAuthorized.selector);
        router.exit(id, other, 0);
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotAuthorized.selector);
        router.exit(id, bytes32(0), 0);
    }

    function test_exit_AlarmNotLive_neverFired() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, pauseKey, 0);
    }

    function test_exit_AlarmNotLive_firedBeforeArming() public {
        _fireAlarm();
        pausable.setPaused(false);
        vm.warp(block.timestamp + 1 days); // armable again; the fire is now before the arming
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, pauseKey, 0);
    }

    function test_exit_AlarmNotLive_firedLongAgo() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        _fireAlarm();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, pauseKey, 0);
    }

    function test_exit_NothingToExit_ownerHoldsNoShares() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vm.prank(OWNER);
        vault.transfer(ATTACKER, 100e18);
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.NothingToExit.selector);
        router.exit(id, bytes32(0), 0);
    }

    function test_exit_NothingToExit_noApproval() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vm.prank(OWNER);
        vault.approve(address(router), 0);
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.NothingToExit.selector);
        router.exit(id, bytes32(0), 0);
    }

    function test_exit_NothingWithdrawn_vaultHasNoLiquidity() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vault.setLiquid(0);
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.NothingWithdrawn.selector);
        router.exit(id, bytes32(0), 0);
        assertEq(vault.balanceOf(OWNER), 100e18, "shares untouched");
    }

    function test_exit_TransferFromFailed_adapterRefusesShares() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        vault.setBlocked(address(adapter), true);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.TransferFromFailed.selector, address(vault)));
        router.exit(id, bytes32(0), 0);
        assertEq(vault.balanceOf(OWNER), 100e18, "shares untouched");
    }

    function test_exit_NftNotReturned() public {
        bytes32 id = _armNft();
        nftAdapter.set(false, 5e6); // pays, but keeps the NFT
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.NftNotReturned.selector);
        router.exit(id, bytes32(0), 0);
        assertTrue(nft.ownerOf(7) == OWNER, "NFT rolled back to the owner");
    }

    function test_exit_NothingWithdrawn_nftReturnedButNothingPaid() public {
        bytes32 id = _armNft();
        nftAdapter.set(true, 0);
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.NothingWithdrawn.selector);
        router.exit(id, bytes32(0), 0);
        assertTrue(nft.ownerOf(7) == OWNER, "NFT rolled back to the owner");
    }

    function test_exit_nftControl_returnedAndPaid() public {
        bytes32 id = _armNft();
        nftAdapter.set(true, 5e6);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertTrue(nft.ownerOf(7) == OWNER, "NFT back with the owner");
        assertEq(stable.balanceOf(OWNER), 5e6, "owner paid");
    }

    function test_exit_Reentrancy_exitAndClaimInsideAnExit() public {
        bytes32 victim = _setup(OWNER, vault, 100e18, RAW, 0);
        _fireAlarm();
        ReentrantVault rv = new ReentrantVault(stable, address(router));
        rv.setVictim(victim, pauseKey, OWNER);
        rv.mint(ATTACKER, 10e18);
        vm.prank(ATTACKER);
        rv.approve(address(router), type(uint256).max);
        vm.prank(ATTACKER);
        bytes32 id = router.arm(_params(address(rv), RAW, 0, new bytes32[](0)));
        vm.prank(ATTACKER);
        router.exit(id, bytes32(0), 0);
        assertTrue(rv.exitError() == ReentrancyGuard.Reentrancy.selector, "exit blocked by the guard");
        assertTrue(rv.claimError() == ReentrancyGuard.Reentrancy.selector, "claimOwed blocked by the guard");
        assertEq(vault.balanceOf(OWNER), 100e18, "victim untouched");
    }

    // ---------------------------------------------------------------- claimOwed

    function test_claimOwed_NothingOwed_nothingBooked() public {
        vm.expectRevert(ExitRouter.NothingOwed.selector);
        router.claimOwed(OWNER, address(stable));
    }

    function test_claimOwed_NothingOwed_wrongOwnerOrToken() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        stable.setBlocked(OWNER, true);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(router.owed(OWNER, address(stable)), 100e6, "booked");
        stable.setBlocked(OWNER, false);
        vm.expectRevert(ExitRouter.NothingOwed.selector);
        router.claimOwed(ATTACKER, address(stable)); // someone else's name
        vm.expectRevert(ExitRouter.NothingOwed.selector);
        router.claimOwed(OWNER, address(weth)); // a token nothing is owed in
        vm.expectRevert(ExitRouter.NothingOwed.selector);
        router.claimOwed(OWNER, address(0)); // ETH
    }

    function test_claimOwed_NothingOwed_secondClaimAfterPaying() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        stable.setBlocked(OWNER, true);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        stable.setBlocked(OWNER, false);
        router.claimOwed(OWNER, address(stable));
        vm.expectRevert(ExitRouter.NothingOwed.selector);
        router.claimOwed(OWNER, address(stable));
    }

    function test_claimOwed_TransferFailed_ownerStillBlocked() public {
        bytes32 id = _setup(OWNER, vault, 100e18, RAW, 0);
        stable.setBlocked(OWNER, true);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.TransferFailed.selector, address(stable)));
        router.claimOwed(OWNER, address(stable));
        assertEq(router.owed(OWNER, address(stable)), 100e6, "still owed after the failed claim");
        assertEq(router.totalOwed(address(stable)), 100e6, "total unchanged");
    }

    function test_claimOwed_NothingOwed_ethOwnerStillRefuses_thenPays() public {
        // A router with no WETH, so ETH the owner refuses is booked as owed in native ETH.
        MockEthAdapter ea = new MockEthAdapter();
        address[] memory adapters = new address[](1);
        adapters[0] = address(ea);
        ExitRouter r = new ExitRouter(
            address(stable), address(0), address(swap), address(book), ADMIN, GUARD, address(stableFeed), 90_000,
            block.timestamp + EXPIRY_FROM_START, adapters
        );
        vm.deal(address(ea), 1 ether);

        EthRejector rej = new EthRejector();
        vault.deposit(address(rej), 10e18);
        rej.run(address(vault), abi.encodeCall(vault.approve, (address(r), type(uint256).max)));
        ExitRouter.ArmParams memory p = ExitRouter.ArmParams({
            adapter: address(ea),
            target: address(vault),
            tokenId: 0,
            harbour: RAW,
            maxSlipBps: 0,
            termsHash: TERMS,
            keys: _keys(pauseKey),
            swaps: new ExitRouter.SwapLeg[](0)
        });
        rej.run(address(r), abi.encodeCall(r.arm, (p)));
        bytes32 id = r.positionId(address(rej), address(ea), address(vault), 0);
        rej.run(address(r), abi.encodeCall(r.exit, (id, bytes32(0), 0)));
        assertEq(r.owed(address(rej), address(0)), 1 ether, "ETH booked as owed");
        assertEq(r.totalOwed(address(0)), 1 ether, "total ETH owed");

        vm.expectRevert(ExitRouter.NothingOwed.selector);
        r.claimOwed(address(rej), address(0));
        assertEq(r.owed(address(rej), address(0)), 1 ether, "unchanged by the failed claim");

        rej.setAccept(true);
        vm.prank(ATTACKER);
        r.claimOwed(address(rej), address(0));
        assertEq(address(rej).balance, 1 ether, "owner paid");
        assertEq(ATTACKER.balance, 0, "caller gets nothing");
        assertEq(r.totalOwed(address(0)), 0, "cleared");
    }

    // ---------------------------------------------------------------- admin and guardian

    function test_setAdapter_NotAdmin() public {
        vm.expectRevert(ExitRouter.NotAdmin.selector);
        router.setAdapter(address(1), true);
        vm.prank(GUARD);
        vm.expectRevert(ExitRouter.NotAdmin.selector);
        router.setAdapter(address(1), true);
    }


    function test_setGuardian_NotAdmin() public {
        vm.prank(GUARD);
        vm.expectRevert(ExitRouter.NotAdmin.selector);
        router.setGuardian(ATTACKER);
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.NotAdmin.selector);
        router.setGuardian(ATTACKER);
    }

    function test_adminFunctions_NotAdmin_afterExpiry() public {
        vm.warp(router.ADMIN_EXPIRY());
        vm.startPrank(ADMIN);
        vm.expectRevert(ExitRouter.NotAdmin.selector);
        router.setAdapter(address(1), true);
        vm.expectRevert(ExitRouter.NotAdmin.selector);
        router.setGuardian(ATTACKER);
        vm.stopPrank();
    }

    function test_noAdminSwapSettingsExist() public {
        // v1's setFeed(address,address,uint32,uint8) and setRoute(address,bytes) are gone: calls to them hit no function.
        vm.startPrank(ADMIN);
        (bool okFeed,) = address(router).call(
            abi.encodeWithSignature("setFeed(address,address,uint32,uint8)", address(weth), address(stableFeed), 3600, 18)
        );
        (bool okRoute,) = address(router).call(abi.encodeWithSignature("setRoute(address,bytes)", address(weth), ""));
        (bool okCfg,) = address(router).call(abi.encodeWithSignature("swapConfig()"));
        vm.stopPrank();
        assertTrue(!okFeed && !okRoute && !okCfg, "no admin swap settings");
    }

    function test_setArmingPaused_NotGuardian_stranger() public {
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.NotGuardian.selector);
        router.setArmingPaused(true);
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.NotGuardian.selector);
        router.setArmingPaused(false);
    }

    function test_setArmingPaused_NotGuardian_afterExpiry() public {
        vm.warp(router.ADMIN_EXPIRY());
        vm.prank(GUARD);
        vm.expectRevert(ExitRouter.NotGuardian.selector);
        router.setArmingPaused(true);
        vm.prank(ADMIN);
        vm.expectRevert(ExitRouter.NotGuardian.selector);
        router.setArmingPaused(true);
    }

    function test_setArmingPaused_adminAndGuardianMay() public {
        vm.prank(ADMIN);
        router.setArmingPaused(true);
        vm.prank(GUARD);
        router.setArmingPaused(false);
    }

    function test_setGuardian_replacedGuardianLosesThePower() public {
        vm.prank(ADMIN);
        router.setGuardian(KEEPER);
        vm.prank(GUARD);
        vm.expectRevert(ExitRouter.NotGuardian.selector);
        router.setArmingPaused(true);
    }

    // ---------------------------------------------------------------- adapter

    function test_adapter_unwind_OnlyRouter() public {
        vm.prank(ATTACKER);
        vm.expectRevert(AdapterBase.OnlyRouter.selector);
        adapter.unwind(address(vault), 1);
        vm.prank(address(router));
        adapter.unwind(address(vault), 1); // the router may (it redeems nothing and returns nothing)
    }
}

// ------------------------------------------------------------------------------------------ AlarmBook

contract AlarmBookReverts is Base {
    uint256 internal constant PK_A = 0xA1;
    uint256 internal constant PK_B = 0xB2;
    uint256 internal constant PK_OUT = 0xDD; // never made a watcher
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    address internal wA;
    address internal wB;
    bytes32 internal quorumKey;
    bytes32 internal constant EVIDENCE = keccak256("evidence");

    function _initialWatchers() internal override returns (address[] memory) {
        return _addrs(vm.addr(PK_A), vm.addr(PK_B));
    }

    function setUp() public override {
        super.setUp();
        wA = vm.addr(PK_A);
        wB = vm.addr(PK_B);
        quorumKey = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xBEEF), 2, 0, 0, 0));
    }

    function _sig(uint256 pk, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Two signers sorted by address, each signing `digest`.
    function _pair(uint256 p1, uint256 p2, bytes32 digest) internal returns (address[] memory s, bytes[] memory g) {
        (uint256 lo, uint256 hi) = vm.addr(p1) < vm.addr(p2) ? (p1, p2) : (p2, p1);
        s = new address[](2);
        g = new bytes[](2);
        s[0] = vm.addr(lo);
        s[1] = vm.addr(hi);
        g[0] = _sig(lo, digest);
        g[1] = _sig(hi, digest);
    }

    function _deadline() internal view returns (uint64) {
        return uint64(block.timestamp + 600);
    }

    function _fireQuorum() internal {
        uint64 dl = _deadline();
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    // ---------------------------------------------------------------- setWatcher

    function test_setWatcher_NotAdmin() public {
        vm.prank(ATTACKER);
        vm.expectRevert(AlarmBook.NotAdmin.selector);
        book.setWatcher(ATTACKER, uint64(block.timestamp + 1 days));
        vm.prank(ATTACKER);
        vm.expectRevert(AlarmBook.NotAdmin.selector);
        book.setWatcher(wA, 0); // cannot remove one either
        assertTrue(book.isWatcher(wA), "still a watcher");
    }

    function test_setWatcher_BadWatcherTerm() public {
        address w = address(0x5EE);
        vm.startPrank(ADMIN);
        vm.expectRevert(AlarmBook.BadWatcherTerm.selector);
        book.setWatcher(w, uint64(block.timestamp)); // ends now
        vm.expectRevert(AlarmBook.BadWatcherTerm.selector);
        book.setWatcher(w, uint64(block.timestamp - 1)); // ended already
        vm.expectRevert(AlarmBook.BadWatcherTerm.selector);
        book.setWatcher(w, uint64(block.timestamp + 365 days + 1)); // beyond MAX_WATCHER_TERM
        vm.expectRevert(AlarmBook.BadWatcherTerm.selector);
        book.setWatcher(w, uint64(block.timestamp + 2 days)); // a new watcher would end before it starts
        book.setWatcher(w, uint64(block.timestamp + 2 days + 1)); // one second of approval: allowed
        book.setWatcher(wA, uint64(block.timestamp + 1)); // an active one may be cut short, effective at once
        book.setWatcher(w, uint64(block.timestamp + 365 days)); // the longest allowed
        vm.stopPrank();
        assertEq(book.watcherSince(w), block.timestamp + 2 days, "a pending watcher re-approved still waits");
    }

    function test_setWatcher_removeIsImmediate() public {
        vm.prank(ADMIN);
        book.setWatcher(wA, 0);
        assertTrue(!book.isWatcher(wA), "removed");
        assertEq(book.watcherSince(wA), 0, "since cleared");
        assertEq(book.watcherUntil(wA), 0, "until cleared");
    }

    // ---------------------------------------------------------------- rebase

    function test_rebase_Unknown() public {
        vm.expectRevert(AlarmBook.Unknown.selector);
        book.rebase(keccak256("never registered"));
    }

    function test_rebase_NotRebasable() public {
        vm.expectRevert(AlarmBook.NotRebasable.selector);
        book.rebase(pauseKey);
        vm.expectRevert(AlarmBook.NotRebasable.selector);
        book.rebase(quorumKey);
        MockFeed f = new MockFeed(1e8);
        bytes32 pk = book.register(_detector(AlarmBook.Kind.PRICE_BELOW, address(f), 0.9e8, 3600, 0, 0));
        vm.expectRevert(AlarmBook.NotRebasable.selector);
        book.rebase(pk);
        bytes32 both = book.register(_detector(AlarmBook.Kind.BOTH, address(0), 0, 1 days, pauseKey, quorumKey));
        vm.expectRevert(AlarmBook.NotRebasable.selector);
        book.rebase(both);
    }

    function _sdTrippedForAWeek() internal returns (bytes32 k) {
        vault.deposit(OWNER, 100e18);
        k = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
        vault.setPrice(0.9e6);
        for (uint256 i; i < 8; ++i) {
            assertTrue(book.poke(k), "fires daily");
            if (i < 7) vm.warp(block.timestamp + 1 days);
        }
    }

    function test_rebase_EpisodeTooShort() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
        vm.expectRevert(AlarmBook.EpisodeTooShort.selector); // never fired
        book.rebase(k);
        vault.setPrice(0.9e6);
        book.poke(k);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(AlarmBook.EpisodeTooShort.selector); // a day into the episode
        book.rebase(k);
    }

    function test_rebase_NotTripped() public {
        bytes32 k = _sdTrippedForAWeek();
        vault.setPrice(1e6); // recovered
        vm.expectRevert(AlarmBook.NotTripped.selector);
        book.rebase(k);
        vault.setPrice(0.9e6);
        book.rebase(k); // tripped again: allowed
    }

    function test_rebase_NotTripped_unreadableTarget() public {
        SwitchVault sv = new SwitchVault();
        bytes32 k = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(sv), 50, 0, 0, 0));
        sv.setPrice(0.9e6);
        for (uint256 i; i < 8; ++i) {
            assertTrue(book.poke(k), "fires daily");
            if (i < 7) vm.warp(block.timestamp + 1 days);
        }
        sv.setBurn(true);
        vm.expectRevert(AlarmBook.NotTripped.selector);
        book.rebase(k);
    }

    // ---------------------------------------------------------------- reads get their full gas

    function test_poke_NotEnoughGas() public {
        pausable.setPaused(true);
        uint256 cap = book.TARGET_READ_GAS();
        (bool ok, bytes memory ret) = address(book).call{gas: cap / 2}(abi.encodeCall(book.poke, (pauseKey)));
        assertTrue(!ok && bytes4(ret) == AlarmBook.NotEnoughGas.selector, "a starved poke reverts, it doesn't read false");
        assertTrue(!book.isLive(pauseKey, 1 days), "nothing fired");
        (ok,) = address(book).call{gas: cap * 2}(abi.encodeCall(book.poke, (pauseKey)));
        assertTrue(ok && book.isLive(pauseKey, 0), "with the cap available it fires");
    }

    function test_armable_NotEnoughGas_neverReadsClear() public {
        pausable.setPaused(true);
        uint256 cap = book.TARGET_READ_GAS();
        (bool ok, bytes memory ret) = address(book).call{gas: cap / 2}(abi.encodeCall(book.armable, (pauseKey)));
        assertTrue(!ok && bytes4(ret) == AlarmBook.NotEnoughGas.selector, "a starved armable reverts");
        (ok, ret) = address(book).call{gas: cap / 2}(abi.encodeCall(book.check, (pauseKey)));
        assertTrue(!ok && bytes4(ret) == AlarmBook.NotEnoughGas.selector, "so does check");
        (ok, ret) = address(book).call{gas: cap / 2}(abi.encodeCall(book.checkpoint, (pauseKey)));
        assertTrue(ok, "checkpoint on a kind with nothing to roll reads nothing");
    }

    // ---------------------------------------------------------------- unknown keys

    function test_poke_Unknown() public {
        vm.expectRevert(AlarmBook.Unknown.selector);
        book.poke(keccak256("never registered"));
    }

    function test_checkpoint_Unknown() public {
        vm.expectRevert(AlarmBook.Unknown.selector);
        book.checkpoint(keccak256("never registered"));
    }

    function test_fireByQuorum_Unknown() public {
        uint64 dl = _deadline();
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, bytes32(0));
        vm.expectRevert(AlarmBook.Unknown.selector);
        book.fireByQuorum(keccak256("never registered"), EVIDENCE, dl, s, g);
    }

    function test_check_unknownKeyIsFalseNotRevert() public view {
        assertTrue(!book.check(keccak256("never registered")), "false");
        assertTrue(!book.isLive(keccak256("never registered"), 1 days), "not live");
    }

    function test_poke_aliveOrUntrippedReturnsFalseInsteadOfReverting() public {
        assertTrue(!book.poke(pauseKey), "not tripped");
        pausable.setPaused(true);
        assertTrue(book.poke(pauseKey), "fires");
        assertTrue(!book.poke(pauseKey), "already live");
    }

    // ---------------------------------------------------------------- register

    function _bad(AlarmBook.Kind k, address t, uint256 th, uint32 w, bytes32 a, bytes32 b) internal {
        AlarmBook.Detector memory d = _detector(k, t, th, w, a, b);
        bytes32 key = book.keyOf(d);
        vm.expectRevert(AlarmBook.BadDetector.selector);
        book.register(d);
        (bool exists,,,,,,,) = book.state(key);
        assertTrue(!exists, "nothing stored by a failed register");
    }

    function test_register_BadDetector_priceBelow() public {
        MockFeed f = new MockFeed(1e8);
        _bad(AlarmBook.Kind.PRICE_BELOW, address(f), 0, 3600, 0, 0); // zero threshold
        _bad(AlarmBook.Kind.PRICE_BELOW, address(f), 1e8, 0, 0, 0); // zero window
        _bad(AlarmBook.Kind.PRICE_BELOW, address(0xFEED), 1e8, 3600, 0, 0); // no code
        book.register(_detector(AlarmBook.Kind.PRICE_BELOW, address(f), 1e8, 3600, 0, 0));
    }

    function test_register_BadDetector_shareDrop() public {
        _bad(AlarmBook.Kind.SHARE_DROP, address(vault), 0, 0, 0, 0); // zero threshold
        _bad(AlarmBook.Kind.SHARE_DROP, address(vault), 10_000, 0, 0, 0); // 100% or more
        _bad(AlarmBook.Kind.SHARE_DROP, address(0xFEED), 50, 0, 0, 0); // no code
        _bad(AlarmBook.Kind.SHARE_DROP, address(pausable), 50, 0, 0, 0); // has code, not a vault
        _bad(AlarmBook.Kind.SHARE_DROP, address(new MockVault(stable, 0)), 50, 0, 0, 0); // share price reads 0
        book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 9_999, 0, 0, 0)); // the highest allowed
    }

    function test_register_BadDetector_paused() public {
        _bad(AlarmBook.Kind.PAUSED, address(0xFEED), 0, 0, 0, 0);
    }

    function test_register_BadDetector_addressChange() public {
        _bad(AlarmBook.Kind.ADDRESS_CHANGE, address(0xFEED), 0, 0, bytes32(bytes4(0x11223344)), 0); // no code
        _bad(AlarmBook.Kind.ADDRESS_CHANGE, address(pausable), 0, 0, 0, 0); // no selector given
        _bad(AlarmBook.Kind.ADDRESS_CHANGE, address(pausable), 0, 0, bytes32(bytes4(0xdeadbeef)), 0); // view reverts
        // paused() returns a bool, which is a valid address-sized word (0 or 1), so this one registers.
        book.register(_detector(AlarmBook.Kind.ADDRESS_CHANGE, address(pausable), 0, 0, bytes32(bytes4(keccak256("paused()"))), 0));
    }

    function test_register_BadDetector_drain() public {
        _bad(AlarmBook.Kind.DRAIN, address(vault), 0, 3600, 0, 0); // zero threshold
        _bad(AlarmBook.Kind.DRAIN, address(vault), 10_000, 3600, 0, 0); // 100% or more
        _bad(AlarmBook.Kind.DRAIN, address(vault), 2500, 0, 0, 0); // zero window
        _bad(AlarmBook.Kind.DRAIN, address(vault), 2500, 1199, 0, 0); // under MIN_DRAIN_WINDOW
        _bad(AlarmBook.Kind.DRAIN, address(0xFEED), 2500, 3600, 0, 0); // no code
        _bad(AlarmBook.Kind.DRAIN, address(pausable), 2500, 3600, 0, 0); // no totalAssets
        _bad(AlarmBook.Kind.DRAIN, address(vault), 2500, 3600, 0, 0); // empty vault: totalAssets is 0
        vault.deposit(OWNER, 100e18);
        book.register(_detector(AlarmBook.Kind.DRAIN, address(vault), 2500, 1200, 0, 0)); // exactly the minimum
    }

    function test_register_BadDetector_quorum() public {
        _bad(AlarmBook.Kind.QUORUM, address(1), 0, 0, 0, 0);
        _bad(AlarmBook.Kind.QUORUM, address(1), 1, 0, 0, 0);
        _bad(AlarmBook.Kind.QUORUM, address(1), 33, 0, 0, 0);
        book.register(_detector(AlarmBook.Kind.QUORUM, address(1), 32, 0, 0, 0)); // MAX_QUORUM
        book.register(_detector(AlarmBook.Kind.QUORUM, address(2), 2, 0, 0, 0));
    }

    function test_register_BadDetector_both() public {
        _bad(AlarmBook.Kind.BOTH, address(0), 0, 1 days, keccak256("x"), keccak256("y")); // neither part exists
        _bad(AlarmBook.Kind.BOTH, address(0), 0, 1 days, pauseKey, keccak256("y")); // b missing
        _bad(AlarmBook.Kind.BOTH, address(0), 0, 1 days, keccak256("x"), quorumKey); // a missing
        _bad(AlarmBook.Kind.BOTH, address(0), 0, 1 days, pauseKey, pauseKey); // same part twice
        _bad(AlarmBook.Kind.BOTH, address(0), 0, 1 days - 1, pauseKey, quorumKey); // window too short
        book.register(_detector(AlarmBook.Kind.BOTH, address(0), 0, 1 days, pauseKey, quorumKey)); // exactly the minimum
    }

    function test_register_existingKeyIsNotRevalidated() public {
        // Registering the same detector again returns its key and never reverts, whatever the target does now.
        bytes32 again = book.register(_detector(AlarmBook.Kind.PAUSED, address(pausable), 0, 0, 0, 0));
        assertTrue(again == pauseKey, "same key");
    }

    // ---------------------------------------------------------------- fireByQuorum

    function test_fireByQuorum_NotQuorumKind() public {
        uint64 dl = _deadline();
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, book.attestDigest(pauseKey, EVIDENCE, dl));
        vm.expectRevert(AlarmBook.NotQuorumKind.selector);
        book.fireByQuorum(pauseKey, EVIDENCE, dl, s, g);
    }

    function test_fireByQuorum_Expired() public {
        uint64 dl = uint64(block.timestamp - 1);
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.expectRevert(AlarmBook.Expired.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_fireByQuorum_deadlineEqualToNowIsStillValid() public {
        uint64 dl = uint64(block.timestamp);
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
        assertTrue(book.isLive(quorumKey, 1 days), "fired");
    }

    function test_fireByQuorum_DeadlineTooFar() public {
        uint64 dl = uint64(block.timestamp + 1 hours + 1);
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.expectRevert(AlarmBook.DeadlineTooFar.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
        dl = uint64(block.timestamp + 1 hours); // exactly MAX_ATTEST_LIFE
        (s, g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_fireByQuorum_AlreadyLive() public {
        _fireQuorum();
        uint64 dl = _deadline();
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.expectRevert(AlarmBook.AlreadyLive.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
        vm.warp(block.timestamp + 1 days - 1);
        dl = _deadline();
        (s, g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.expectRevert(AlarmBook.AlreadyLive.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
        vm.warp(block.timestamp + 1); // REFIRE_AFTER reached
        dl = _deadline();
        (s, g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_fireByQuorum_BadSigners_belowThreshold() public {
        uint64 dl = _deadline();
        address[] memory s = new address[](1);
        bytes[] memory g = new bytes[](1);
        s[0] = wA;
        g[0] = _sig(PK_A, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.expectRevert(AlarmBook.BadSigners.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_fireByQuorum_BadSigners_noSigners() public {
        vm.expectRevert(AlarmBook.BadSigners.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, _deadline(), new address[](0), new bytes[](0));
    }

    function test_fireByQuorum_BadSigners_lengthMismatch() public {
        uint64 dl = _deadline();
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        bytes[] memory one = new bytes[](1);
        one[0] = g[0];
        vm.expectRevert(AlarmBook.BadSigners.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, one);
    }

    function test_fireByQuorum_BadSigners_unsortedOrDuplicate() public {
        uint64 dl = _deadline();
        bytes32 digest = book.attestDigest(quorumKey, EVIDENCE, dl);
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, digest);
        (s[0], s[1]) = (s[1], s[0]); // descending
        (g[0], g[1]) = (g[1], g[0]);
        vm.expectRevert(AlarmBook.BadSigners.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
        (s, g) = _pair(PK_A, PK_B, digest);
        s[1] = s[0]; // the same watcher twice
        g[1] = g[0];
        vm.expectRevert(AlarmBook.BadSigners.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_fireByQuorum_BadSigners_zeroAddressFirst() public {
        // address(0) can never be "above" the starting previous signer of 0.
        uint64 dl = _deadline();
        address[] memory s = new address[](2);
        bytes[] memory g = new bytes[](2);
        s[0] = address(0);
        s[1] = wA;
        g[0] = new bytes(65);
        g[1] = _sig(PK_A, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.expectRevert(AlarmBook.BadSigners.selector);
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_fireByQuorum_NotWatcher_neverApproved() public {
        uint64 dl = _deadline();
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_OUT, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.expectRevert(abi.encodeWithSelector(AlarmBook.NotWatcher.selector, vm.addr(PK_OUT)));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_fireByQuorum_NotWatcher_removed() public {
        vm.prank(ADMIN);
        book.setWatcher(wB, 0);
        uint64 dl = _deadline();
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.expectRevert(abi.encodeWithSelector(AlarmBook.NotWatcher.selector, wB));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    /// @dev Signer index 0 is checked first, so a bad signature there is the one reported.
    function _expectBadSig(bytes memory bad, address[] memory s, bytes[] memory g, uint64 dl) internal {
        g[0] = bad;
        vm.expectRevert(abi.encodeWithSelector(AlarmBook.BadSignature.selector, s[0]));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_fireByQuorum_BadSignature_signedAnotherDigest() public {
        uint64 dl = _deadline();
        bytes32 digest = book.attestDigest(quorumKey, EVIDENCE, dl);
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, digest);
        uint256 pk0 = s[0] == wA ? PK_A : PK_B;
        _expectBadSig(_sig(pk0, book.attestDigest(quorumKey, keccak256("other evidence"), dl)), s, g, dl);
    }

    function test_fireByQuorum_BadSignature_signedByTheOtherWatcher() public {
        uint64 dl = _deadline();
        bytes32 digest = book.attestDigest(quorumKey, EVIDENCE, dl);
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, digest);
        _expectBadSig(g[1], s, g, dl); // signer 1's signature presented for signer 0
    }

    function test_fireByQuorum_BadSignature_highS() public {
        uint64 dl = _deadline();
        bytes32 digest = book.attestDigest(quorumKey, EVIDENCE, dl);
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, digest);
        uint256 pk0 = s[0] == wA ? PK_A : PK_B;
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(pk0, digest);
        // The mirror signature recovers to the same signer, but malleable signatures are refused.
        bytes memory flipped = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(sv)), v == 27 ? uint8(28) : uint8(27));
        _expectBadSig(flipped, s, g, dl);
    }

    function test_fireByQuorum_BadSignature_wrongLengthOrEmpty() public {
        uint64 dl = _deadline();
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        bytes memory good = g[0];
        _expectBadSig(new bytes(0), s, g, dl);
        _expectBadSig(new bytes(64), s, g, dl);
        _expectBadSig(new bytes(66), s, g, dl);
        g[0] = good;
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g); // the untouched signatures work
    }

    function test_fireByQuorum_BadSignature_badRecoveryId() public {
        uint64 dl = _deadline();
        bytes32 digest = book.attestDigest(quorumKey, EVIDENCE, dl);
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, digest);
        uint256 pk0 = s[0] == wA ? PK_A : PK_B;
        (, bytes32 r, bytes32 sv) = vm.sign(pk0, digest);
        _expectBadSig(abi.encodePacked(r, sv, uint8(29)), s, g, dl);
    }

    function test_fireByQuorum_NotWatcher_approvedButNotYetActive() public {
        vm.prank(ADMIN);
        book.setWatcher(wB, 0);
        vm.prank(ADMIN);
        book.setWatcher(wB, uint64(block.timestamp + 30 days)); // re-approved: waits WATCHER_DELAY
        uint64 dl = _deadline();
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.expectRevert(abi.encodeWithSelector(AlarmBook.NotWatcher.selector, wB));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
        vm.warp(block.timestamp + 2 days);
        dl = _deadline();
        (s, g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_fireByQuorum_NotWatcher_expired() public {
        vm.warp(block.timestamp + 365 days); // the constructor's approvals end
        uint64 dl = _deadline();
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_B, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.expectRevert(abi.encodeWithSelector(AlarmBook.NotWatcher.selector, s[0]));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_fireByQuorum_BadSignature_contractWatcherSaysNo() public {
        RefusingWallet w = new RefusingWallet();
        _approveWatcher(address(w));
        vm.warp(block.timestamp + 2 days);
        uint64 dl = _deadline();
        bytes32 digest = book.attestDigest(quorumKey, EVIDENCE, dl);
        address[] memory s = new address[](2);
        bytes[] memory g = new bytes[](2);
        if (wA < address(w)) {
            (s[0], s[1]) = (wA, address(w));
            (g[0], g[1]) = (_sig(PK_A, digest), new bytes(65));
        } else {
            (s[0], s[1]) = (address(w), wA);
            (g[0], g[1]) = (new bytes(65), _sig(PK_A, digest));
        }
        vm.expectRevert(abi.encodeWithSelector(AlarmBook.BadSignature.selector, address(w)));
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
    }

    function test_fireByQuorum_aFailedAttemptLeavesNothingFired() public {
        uint64 dl = _deadline();
        (address[] memory s, bytes[] memory g) = _pair(PK_A, PK_OUT, book.attestDigest(quorumKey, EVIDENCE, dl));
        vm.expectRevert();
        book.fireByQuorum(quorumKey, EVIDENCE, dl, s, g);
        assertTrue(!book.isLive(quorumKey, 1 days), "not fired");
        assertTrue(book.signersOf(quorumKey).length == 0, "no signers recorded");
    }
}

// ------------------------------------------------------------------------------------------ Timelock

contract TimelockReverts is Base {
    Timelock internal lock;
    ExitRouter internal locked;

    function setUp() public override {
        super.setUp();
        lock = new Timelock(ADMIN, 48 hours);
        locked = new ExitRouter(
            address(stable), address(weth), address(swap), address(book), address(lock), GUARD, address(stableFeed), 90_000,
            block.timestamp + EXPIRY_FROM_START, new address[](0)
        );
    }

    function _data() internal pure returns (bytes memory) {
        return abi.encodeCall(ExitRouter.setAdapter, (address(0x1234), true));
    }

    function _schedule() internal returns (bytes32 id) {
        vm.prank(ADMIN);
        id = lock.schedule(address(locked), 0, _data(), 0);
    }

    function test_constructor_DelayTooLong() public {
        vm.expectRevert(Timelock.DelayTooLong.selector);
        new Timelock(ADMIN, 30 days + 1);
        new Timelock(ADMIN, 30 days); // exactly MAX_DELAY
    }

    function test_schedule_NotProposer() public {
        vm.prank(ATTACKER);
        vm.expectRevert(Timelock.NotProposer.selector);
        lock.schedule(address(locked), 0, _data(), 0);
    }

    function test_cancel_NotProposer() public {
        bytes32 id = _schedule();
        vm.prank(ATTACKER);
        vm.expectRevert(Timelock.NotProposer.selector);
        lock.cancel(id);
        assertTrue(lock.eta(id) != 0, "still scheduled");
    }

    function test_execute_NotProposer() public {
        _schedule();
        vm.warp(block.timestamp + 48 hours);
        vm.prank(ATTACKER);
        vm.expectRevert(Timelock.NotProposer.selector);
        lock.execute(address(locked), 0, _data(), 0);
    }

    function test_schedule_AlreadyScheduled() public {
        _schedule();
        vm.prank(ADMIN);
        vm.expectRevert(Timelock.AlreadyScheduled.selector);
        lock.schedule(address(locked), 0, _data(), 0);
        vm.prank(ADMIN);
        lock.schedule(address(locked), 0, _data(), bytes32(uint256(1))); // a new salt is a new change
    }

    function test_execute_NotReady_neverScheduled() public {
        vm.prank(ADMIN);
        vm.expectRevert(Timelock.NotReady.selector);
        lock.execute(address(locked), 0, _data(), 0);
    }

    function test_execute_NotReady_beforeTheDelay() public {
        _schedule();
        vm.warp(block.timestamp + 48 hours - 1);
        vm.prank(ADMIN);
        vm.expectRevert(Timelock.NotReady.selector);
        lock.execute(address(locked), 0, _data(), 0);
        vm.warp(block.timestamp + 1);
        vm.prank(ADMIN);
        lock.execute(address(locked), 0, _data(), 0);
    }

    function test_execute_NotReady_afterCancel() public {
        bytes32 id = _schedule();
        vm.prank(ADMIN);
        lock.cancel(id);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(ADMIN);
        vm.expectRevert(Timelock.NotReady.selector);
        lock.execute(address(locked), 0, _data(), 0);
    }

    function test_execute_NotReady_secondExecution() public {
        _schedule();
        vm.warp(block.timestamp + 48 hours);
        vm.prank(ADMIN);
        lock.execute(address(locked), 0, _data(), 0);
        vm.prank(ADMIN);
        vm.expectRevert(Timelock.NotReady.selector);
        lock.execute(address(locked), 0, _data(), 0);
    }

    function test_execute_Lapsed() public {
        _schedule();
        vm.warp(block.timestamp + 48 hours + 14 days + 1);
        vm.prank(ADMIN);
        vm.expectRevert(Timelock.Lapsed.selector);
        lock.execute(address(locked), 0, _data(), 0);
    }

    function test_execute_lastSecondOfTheGraceWindowStillWorks() public {
        _schedule();
        vm.warp(block.timestamp + 48 hours + 14 days);
        vm.prank(ADMIN);
        lock.execute(address(locked), 0, _data(), 0);
        assertTrue(locked.adapterAllowed(address(0x1234)), "applied");
    }

    function test_execute_CallFailed_carriesTheInnerError() public {
        bytes memory bad = abi.encodeCall(ExitRouter.disarm, (keccak256("not the Timelock's position")));
        vm.prank(ADMIN);
        lock.schedule(address(locked), 0, bad, 0);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(Timelock.CallFailed.selector, abi.encodeWithSelector(ExitRouter.NotOwner.selector)));
        lock.execute(address(locked), 0, bad, 0);
        bytes32 id = lock.idOf(address(locked), 0, bad, 0);
        assertTrue(lock.eta(id) != 0, "a failed execution stays scheduled");
    }

    function test_cancel_unknownIdIsHarmless() public {
        vm.prank(ADMIN);
        lock.cancel(keccak256("nothing"));
    }
}
