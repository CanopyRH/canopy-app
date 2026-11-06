// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.sol";
import {AlarmBook} from "../../src/AlarmBook.sol";
import {ExitRouter} from "../../src/ExitRouter.sol";
import {MockERC20, MockVault, MockFeed} from "../Mocks.sol";
import {RealVault, FlashAttacker} from "../AlarmAttacks.t.sol";
import {Whale} from "../AlarmLimits.t.sol";

/// @dev A token whose decimals() burns all the gas it is given.
contract GasBurnDecimalsToken {
    uint256 internal x;

    function decimals() external view returns (uint8) {
        uint256 y = x;
        while (true) y++;
        return uint8(y);
    }
}

/// @dev A token with no decimals() at all (decimals is optional in ERC-20).
contract NoDecimalsToken {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}

/// @notice Verification of the V3 fixes at 5247085 (review on verify-v3).
contract V3VerifyTest is Base {
    uint32 internal constant WINDOW = 3600;
    uint256 internal constant LOAN = 500e18;

    MockERC20 internal asset;
    RealVault internal rv;
    FlashAttacker internal fa;
    bytes32 internal key;
    bytes32 internal posId;
    bytes32 internal quorum;
    bytes32 internal both;

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
        // Two honest rolls: the reference is live at the real 1000.
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key);
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key);
        vm.prank(OWNER);
        rv.approve(address(router), type(uint256).max);
        // v2-fix2: a bare DRAIN key can't be armed; the owner arms it inside BOTH with a QUORUM key, as the app does.
        quorum = book.register(_detector(AlarmBook.Kind.QUORUM, address(rv), 2, 0, 0, 0));
        both = book.register(_detector(AlarmBook.Kind.BOTH, address(rv), 0, 1 days, key, quorum));
        vm.prank(OWNER);
        posId = router.arm(_params(address(rv), 0, 0, _keys(both)));
    }

    function _flash() internal {
        asset.mint(address(fa), LOAN);
        fa.flash(book, rv, key, LOAN);
    }

    function _snapAt() internal view returns (uint64 t) {
        (,, t,,,,,) = book.state(key);
    }

    /// @dev The keeper is down for one window: the attacker lands a flash deposit on two rolls in a row.
    function _twoUnsampledPeriods() internal {
        vm.warp(block.timestamp + WINDOW / 2);
        _flash();
        vm.warp(block.timestamp + WINDOW / 2);
        _flash();
        vm.warp(block.timestamp + WINDOW / 2);
        _flash(); // snap 1500, prevSnap 1500
        assertTrue(book.check(key), "tripped with the vault whole");
    }

    /// V3-01 residual (Low), now closed at the router. The DRAIN logic is unchanged: after a one-window sampling lapse,
    /// an attacker who lands a flash deposit on each roll keeps both period lows inflated, so even against a keeper that
    /// samples and pokes every 10 minutes the DRAIN key stays tripped and refires every 24 hours with the vault whole.
    /// But a DRAIN key can't be armed on its own (DrainNeedsQuorum), and inside BOTH it fires nothing without the
    /// watchers' quorum, so nobody is exited.
    function test_V3V_01_oneHourLapse_thenWinningEachRoll_keepsDrainFiringAgainstASamplingKeeper() public {
        asset.mint(KEEPER, 10e18);
        vm.startPrank(KEEPER);
        asset.approve(address(rv), 10e18);
        rv.deposit(10e18, KEEPER);
        rv.approve(address(router), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.DrainNeedsQuorum.selector, key));
        router.arm(_params(address(rv), 0, 0, _keys(key)));
        vm.stopPrank();
        _twoUnsampledPeriods();
        uint256 fires;
        uint256 firstFire;
        uint256 end = block.timestamp + 2 days + 1 hours;
        while (block.timestamp < end) {
            uint256 rollAt = uint256(_snapAt()) + WINDOW + 1;
            if (rollAt > block.timestamp && rollAt <= block.timestamp + 600) {
                vm.warp(rollAt);
                _flash(); // the attacker takes the roll before the keeper's next pass
            } else {
                vm.warp(block.timestamp + 600);
            }
            book.checkpoint(key); // the keeper's sample: ignored while tripped
            if (book.poke(key)) {
                if (fires++ == 0) firstFire = block.timestamp;
            }
        }
        assertTrue(fires >= 3, "the DRAIN part fired, then refired on each of the next two days");
        assertEq(rv.totalAssets(), 1010e18, "the vault never lost anything");
        assertTrue(book.isLive(key, 1 days), "live again at the end");
        assertTrue(!book.poke(both), "BOTH never fires without the quorum");
        assertTrue(!book.isLive(both, 30 days), "and never fired");
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotAuthorized.selector);
        router.exit(posId, key, 0); // the DRAIN key isn't armed on the position
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(posId, both, 0);
        assertEq(rv.balanceOf(OWNER), 1000e18, "the owner keeps the position");
    }

    /// Control: if the keeper wins one roll after the lapse, the key heals two rolls later, as the fix intends.
    function test_V3V_01_control_oneHonestRollHeals() public {
        _twoUnsampledPeriods();
        vm.warp(uint256(_snapAt()) + WINDOW + 1);
        book.checkpoint(key); // honest roll: snap 1500 (stuck candidate), prevSnap 1500, candidate 1000
        assertTrue(book.check(key), "still tripped right after");
        vm.warp(uint256(_snapAt()) + WINDOW + 1);
        _flash(); // the attacker's flash on the next roll no longer matters: snap 1000
        assertTrue(!book.check(key), "healed");
    }

    /// V3-04 fix side effect (Info). `armable` is false while a DRAIN sighting is pending, and a sighting lasts the whole
    /// window whatever the vault reads afterwards. A holder of a quarter of the vault who dips and pokes once a window
    /// (never twice, so it never fires) keeps a DRAIN key unarmable for as long as it likes. The app arms BOTH keys,
    /// which this doesn't touch.
    function test_V3V_04_oneDipPerWindowKeepsADrainKeyUnarmable() public {
        Whale whale = new Whale();
        asset.mint(address(whale), 400e18);
        whale.deposit(rv, 400e18);
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key);
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key);
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key); // both period lows 1400: reference 1400
        assertTrue(book.armable(key), "control: armable before the first dip");
        for (uint256 i; i < 6; ++i) {
            assertTrue(!whale.dip(book, rv, key, 400e18, true), "a sighting, no fire");
            for (uint256 j; j < 6; ++j) {
                vm.warp(block.timestamp + 600);
                book.checkpoint(key);
                assertTrue(!book.armable(key), "not armable while the sighting is pending");
            }
            vm.warp(block.timestamp + 1);
        }
        assertTrue(!book.isLive(key, 30 days), "it never fired");
    }

    /// V3-03 fix, checked and fine: a leg token whose decimals() burns gas or doesn't exist fails closed (BadFeed) at a
    /// bounded cost, so the new read can't be used to grief anyone but the arming owner, and only by its own token choice.
    function test_V3V_03_hostileOrMissingDecimals_failClosedAtBoundedCost() public {
        MockFeed f = new MockFeed(1e8);
        address[2] memory tokens = [address(new GasBurnDecimalsToken()), address(new NoDecimalsToken())];
        for (uint256 i; i < 2; ++i) {
            ExitRouter.SwapLeg memory l = _leg(tokens[i], address(f));
            ExitRouter.ArmParams memory p = _swapParams(address(vault), 50, _keys(pauseKey), _legs(l));
            uint256 g0 = gasleft();
            (bool ok, bytes memory ret) = address(router).call(abi.encodeCall(router.arm, (p)));
            uint256 used = g0 - gasleft();
            assertTrue(!ok && bytes4(ret) == ExitRouter.BadFeed.selector, "refused");
            assertTrue(used < 250_000, "the read costs at most its cap");
        }
    }

    /// Fix side effect (Info). Measuring against the lower of two period lows makes DRAIN lag growth by one more period.
    /// After the vault quadruples, a real 50% drain doesn't trip until the old low has aged out of prevSnap; before the
    /// fix it tripped one roll after the inflow. Here: 1000 -> 4000, one roll, then half the vault is taken.
    function test_V3V_01_growthLagsOneMorePeriod_aRealDrainAfterAnInflowWaits() public {
        Whale whale = new Whale();
        asset.mint(address(whale), 3000e18);
        whale.deposit(rv, 3000e18);
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key); // snap 1000 (that period's low), candidate 4000
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key); // snap 4000, prevSnap 1000: the reference is still 1000
        rv.exploitDrain(ATTACKER, 2000e18);
        assertTrue(!book.check(key), "half of a 4000 vault gone, and the key reads clear");
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key); // still clear (2000 vs 750), so it rolls: prevSnap 4000, snap 4000
        (,,,, uint256 snap,,, uint256 prev) = book.state(key);
        assertTrue(prev == 4000e18 && snap == 4000e18, "only now is the reference 4000");
        assertTrue(book.check(key), "and the drain trips, a period late");
    }
}
