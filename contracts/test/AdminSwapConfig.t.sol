// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {MockERC20, MockVault, MockFeed} from "./Mocks.sol";

/// Regression for M-1 (and A2-07), from the 2026-11-05 review's proof of concept (.audit-grade/2026-11-05/POCS/contracts/
/// AdminSwapConfig.t.sol). In v1 the admin (a Timelock with delay 0) could set a feed and a route for a token, and a user
/// who armed on the Stable harbour afterwards got that swap: a feed reporting a near-zero price made the oracle-bounded
/// minimum about 0, and a pool the admin controlled took $20,000 of tokens for $10. v2 has no admin swap settings: the
/// owner names the feed and route of every leg when arming, so the exploit has nothing to call.
contract AdminSwapConfigTest is Base {
    MockERC20 internal tok;
    MockVault internal tokVault;
    MockFeed internal tokFeed;

    function setUp() public override {
        super.setUp();
        tok = new MockERC20(18);
        tokVault = new MockVault(tok, 1e18); // 1 share = 1 TOK
        tokFeed = new MockFeed(2_000e8); // honest price: 1 TOK = $2,000
    }

    function _route() internal view returns (bytes memory) {
        return abi.encodePacked(address(tok), uint24(3000), address(stable));
    }

    function _honestLeg() internal view returns (ExitRouter.SwapLeg memory) {
        return ExitRouter.SwapLeg({token: address(tok), feed: address(tokFeed), heartbeat: 90_000, tokenDecimals: 18, path: _route()});
    }

    /// The admin's v1 calls no longer exist, as the admin or anyone else.
    function test_adminHasNoSwapSettings() public {
        MockFeed evilFeed = new MockFeed(100);
        vm.startPrank(ADMIN);
        (bool okFeed,) = address(router).call(
            abi.encodeWithSignature("setFeed(address,address,uint32,uint8)", address(tok), address(evilFeed), 90_000, 18)
        );
        (bool okRoute,) = address(router).call(abi.encodeWithSignature("setRoute(address,bytes)", address(tok), _route()));
        (bool okFeeds,) = address(router).call(abi.encodeWithSignature("feeds(address)", address(tok)));
        (bool okRoutes,) = address(router).call(abi.encodeWithSignature("routes(address)", address(tok)));
        vm.stopPrank();
        assertTrue(!okFeed && !okRoute && !okFeeds && !okRoutes, "no admin feed, route or swap config");
    }

    /// The v1 exploit, replayed against v2: the admin tries to install its feed and route, the owner arms on the Stable
    /// harbour with the leg it chose (the honest feed), and the admin's pool pays $1 per TOK. The swap is skipped and the
    /// owner gets the raw TOK: $20,000, not $10.
    function test_v1Exploit_adminFeedAndRoute_cantReachAStableHarbourExit() public {
        MockFeed evilFeed = new MockFeed(100); // $0.000001 with 8 decimals
        vm.startPrank(ADMIN);
        (bool okFeed,) = address(router).call(
            abi.encodeWithSignature("setFeed(address,address,uint32,uint8)", address(tok), address(evilFeed), 90_000, 18)
        );
        (bool okRoute,) = address(router).call(abi.encodeWithSignature("setRoute(address,bytes)", address(tok), _route()));
        vm.stopPrank();
        assertTrue(!okFeed && !okRoute, "the admin's calls fail");
        swap.setRate(1e6); // the admin's pool: $1 per TOK

        bytes32 posId = _setupSwap(OWNER, tokVault, 10e18, 100, _legs(_honestLeg()));
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(posId, pauseKey, 0);

        assertEq(tok.balanceOf(OWNER), 10e18, "the owner keeps all $20,000 of TOK");
        assertEq(stable.balanceOf(OWNER), 0, "nothing sold at $1");
        assertEq(tok.balanceOf(address(swap)), 0, "the pool got nothing");
    }

    /// Control: the owner's honest leg with a fair pool swaps.
    function test_control_ownersHonestLeg_swapsAtAFairPool() public {
        swap.setRate(1e6);
        bytes32 posId = _setupSwap(OWNER, tokVault, 10e18, 100, _legs(_honestLeg()));
        swap.setRate(1_995e6); // a fair pool, 0.25% under the oracle
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(posId, pauseKey, 0);
        assertEq(stable.balanceOf(OWNER), 19_950e6, "swapped at the fair pool");
        assertEq(tok.balanceOf(OWNER), 0, "no raw TOK");
    }

    /// The only way to a bad feed is the owner's own choice, and a later re-arm by the owner is the only way to change it.
    function test_legsChangeOnlyWhenTheOwnerReArms() public {
        bytes32 posId = _setupSwap(OWNER, tokVault, 10e18, 100, _legs(_honestLeg()));
        ExitRouter.SwapLeg[] memory legs = router.swapsOf(posId);
        assertTrue(legs.length == 1 && legs[0].feed == address(tokFeed), "the owner's feed");
        vm.prank(ATTACKER); // someone else arming the same vault writes their own position, not this one
        router.arm(_swapParams(address(tokVault), 100, _keys(pauseKey), _legs(_honestLeg())));
        legs = router.swapsOf(posId);
        assertTrue(legs.length == 1 && legs[0].feed == address(tokFeed), "unchanged");
    }
}
