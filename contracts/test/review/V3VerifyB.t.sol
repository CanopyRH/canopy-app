// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.sol";
import {AlarmBook} from "../../src/AlarmBook.sol";
import {ExitRouter} from "../../src/ExitRouter.sol";
import {MockERC20} from "../Mocks.sol";
import {RealVault} from "../AlarmAttacks.t.sol";
import {Whale} from "../AlarmLimits.t.sol";

/// @notice Verification of the DrainNeedsQuorum fix at 466c807 (review on verify-v3b).
///
/// V3B-01 (Low). `arm` refuses a bare DRAIN key but never looks inside a BOTH key, so "DRAIN only counts as a part of a
/// BOTH key paired with a QUORUM key" (SECURITY.md, INVARIANTS.md R9) doesn't hold on chain. A BOTH of two DRAIN keys on
/// the same vault (here thresholds 25% and 25.01%), or a BOTH of a DRAIN and any non-quorum key, arms fine; the documented
/// whale dip fires both parts, the BOTH key fires, and a keeper exits the owner with no watcher signature and no loss.
contract V3VerifyBTest is Base {
    uint32 internal constant WINDOW = 3600;

    MockERC20 internal asset;
    RealVault internal rv;
    Whale internal whale;
    bytes32 internal d1;
    bytes32 internal d2;

    function setUp() public override {
        super.setUp();
        asset = new MockERC20(18);
        rv = new RealVault(asset);
        whale = new Whale();
        asset.mint(address(whale), 400e18);
        whale.deposit(rv, 400e18);
        asset.mint(OWNER, 600e18);
        vm.prank(OWNER);
        asset.approve(address(rv), 600e18);
        vm.prank(OWNER);
        rv.deposit(600e18, OWNER);
        d1 = book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2500, WINDOW, 0, 0));
        d2 = book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2501, WINDOW, 0, 0));
        for (uint256 i; i < 2; ++i) {
            vm.warp(block.timestamp + WINDOW / 2);
            book.checkpoint(d1);
            book.checkpoint(d2);
        }
        vm.prank(OWNER);
        rv.approve(address(router), type(uint256).max);
    }

    function _arm(bytes32 k) internal returns (bytes32) {
        vm.prank(OWNER);
        return router.arm(_params(address(rv), 0, 0, _keys(k)));
    }

    /// Control: the fix refuses the bare DRAIN key.
    function test_V3B_control_bareDrainIsRefused() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.DrainNeedsQuorum.selector, d1));
        router.arm(_params(address(rv), 0, 0, _keys(d1)));
    }

    function test_V3B_01_bothOfTwoDrains_exitsWithNoQuorumAndNoLoss() public {
        bytes32 both = book.register(_detector(AlarmBook.Kind.BOTH, address(rv), 0, 1 days, d1, d2));
        bytes32 id = _arm(both); // accepted: the router only checks the BOTH key's own kind

        // The documented whale limit, applied to both parts: dip and poke, then again a minute later.
        whale.dip(book, rv, d1, 400e18, true);
        whale.dip(book, rv, d2, 400e18, true);
        vm.warp(block.timestamp + 60);
        assertTrue(whale.dip(book, rv, d1, 400e18, true), "first DRAIN part fires");
        assertTrue(whale.dip(book, rv, d2, 400e18, true), "second DRAIN part fires");
        assertTrue(book.poke(both), "the BOTH key fires with no watcher involved");

        vm.prank(KEEPER);
        router.exit(id, both, 0);
        assertEq(asset.balanceOf(OWNER), 600e18, "exited on a drain that never happened, with no quorum");
        assertEq(rv.totalAssets(), 400e18, "only the owner's own withdrawal left the vault");
    }

    /// The same through BOTH(DRAIN, X) for any non-quorum X. Here X is a PAUSED key on a contract whose switch anyone can
    /// flip (the test's MockPausable), so one pair of whale dips is all it takes.
    function test_V3B_01_bothOfDrainAndAnAttackerKey_exitsWithNoQuorum() public {
        bytes32 both = book.register(_detector(AlarmBook.Kind.BOTH, address(rv), 0, 1 days, d1, pauseKey));
        bytes32 id = _arm(both);
        whale.dip(book, rv, d1, 400e18, true);
        vm.warp(block.timestamp + 60);
        assertTrue(whale.dip(book, rv, d1, 400e18, true), "DRAIN part fires");
        _fireAlarm(); // the PAUSED part: any switch the attacker can flip
        assertTrue(book.poke(both), "BOTH fires");
        vm.prank(KEEPER);
        router.exit(id, both, 0);
        assertEq(asset.balanceOf(OWNER), 600e18, "exited with no quorum");
    }
}
