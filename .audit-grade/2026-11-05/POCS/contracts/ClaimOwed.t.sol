// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {ExitRouter} from "../src/ExitRouter.sol";

/// Suggested regression tests for claimOwed, which has no test in the repo. These pass on the audited commit.
contract ClaimOwedCheck is Base {
    function test_blockedOwnerIsOwed_thenClaimsAfterUnblock() public {
        bytes32 posId = _setup(OWNER, vault, 100e18, 0, 0);
        stable.setBlocked(OWNER, true);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(posId, pauseKey, 0);
        assertEq(router.owed(OWNER, address(stable)), 100e6, "owed recorded");
        assertEq(router.totalOwed(address(stable)), 100e6, "total owed");

        vm.expectRevert(); // still blocked: nothing moves anywhere else
        router.claimOwed(OWNER, address(stable));

        stable.setBlocked(OWNER, false);
        vm.prank(ATTACKER); // anyone may trigger it, and it still pays only the owner
        router.claimOwed(OWNER, address(stable));
        assertEq(stable.balanceOf(OWNER), 100e6, "owner paid");
        assertEq(stable.balanceOf(ATTACKER), 0, "caller gets nothing");
        assertEq(router.totalOwed(address(stable)), 0, "cleared");
    }

    function test_nothingOwedReverts() public {
        vm.expectRevert(ExitRouter.NothingOwed.selector);
        router.claimOwed(OWNER, address(stable));
    }
}
