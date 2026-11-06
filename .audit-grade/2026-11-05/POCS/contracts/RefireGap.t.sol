// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {ExitRouter} from "../src/ExitRouter.sol";

/// PoC for L-1. A position armed while an alarm is already live can't be exited by a keeper until the
/// alarm can refire, up to REFIRE_AFTER (24 h) later, even though the danger condition holds throughout.
contract RefireGapPoC is Base {
    function test_poc_armedAfterFire_waits24h() public {
        _fireAlarm(); // vault paused at T
        vm.warp(block.timestamp + 1 hours);
        bytes32 posId = _setup(OWNER, vault, 100e18, 0, 0); // owner arms one hour into the incident

        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(posId, pauseKey, 0);
        assertTrue(!book.poke(pauseKey), "can't refire yet");

        vm.warp(block.timestamp + 23 hours); // T + 24h
        assertTrue(book.poke(pauseKey), "refires");
        vm.prank(KEEPER);
        router.exit(posId, pauseKey, 0); // only now
        assertEq(vault.balanceOf(OWNER), 0, "exited after 24h");
    }
}
