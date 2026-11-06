// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {IExitAdapter} from "../src/interfaces/IExitAdapter.sol";
import {MockERC20, MockVault, MockFeed} from "./Mocks.sol";

/// @dev A token whose transfer succeeds but returns one byte instead of a 32-byte bool.
contract ShortToken is MockERC20 {
    constructor() MockERC20(6) {}

    function transfer(address to, uint256 a) public override returns (bool) {
        _move(msg.sender, to, a);
        assembly {
            mstore(0x00, 1)
            return(0x1f, 1)
        }
    }
}

/// @dev A vault whose redeem pays its asset by minting, so the odd token never has to be decoded by a vault.
contract MintVault is MockERC20 {
    MockERC20 public immutable tok;

    constructor(MockERC20 t) MockERC20(18) {
        tok = t;
    }

    function asset() external view returns (address) {
        return address(tok);
    }

    function maxRedeem(address) external pure returns (uint256) {
        return 0;
    }

    function redeem(uint256 s, address receiver, address owner_) external returns (uint256) {
        _burn(owner_, s);
        tok.mint(receiver, s);
        return s;
    }
}

/// @dev Burns every unit of gas it is given.
contract GasBurnFeed {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        assembly {
            invalid()
        }
    }
}

/// @dev An allowlisted adapter that unwinds into native ETH.
contract EthAdapter is IExitAdapter {
    address public immutable ROUTER;

    constructor(address r) {
        ROUTER = r;
    }

    receive() external payable {}

    function positionAsset(address t) external pure returns (address, bool) {
        return (t, false);
    }

    function outputs(address, uint256) external pure returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(0);
    }

    function unwind(address, uint256 amt) external {
        require(msg.sender == ROUTER, "router");
        (bool ok,) = ROUTER.call{value: amt}("");
        require(ok, "send");
    }
}

contract Weth is MockERC20 {
    constructor() MockERC20(18) {}

    function deposit() external payable {
        mint(msg.sender, msg.value);
    }
}

/// @dev A contract owner whose ETH acceptance can be switched.
contract Owner {
    bool public acceptEth;

    receive() external payable {
        require(acceptEth, "no eth");
    }

    function setAccept(bool b) external {
        acceptEth = b;
    }

    function approve(address t, address s) external {
        MockERC20(t).approve(s, type(uint256).max);
    }

    function arm(ExitRouter r, ExitRouter.ArmParams calldata p) external returns (bytes32) {
        return r.arm(p);
    }

    function exitIt(ExitRouter r, bytes32 id) external {
        r.exit(id, bytes32(0), 0);
    }
}

/// @notice Documented edge behaviour of ExitRouter, pinned as regression tests, plus the ETH and WETH payout paths.
contract RouterEdgesTest is Base {
    // ------------------------------------------------------------------ tryTransfer reads a 1-byte return as failure

    function test_oneByteReturnTokenIsPaidAndAlsoBookedAsOwed() public {
        ShortToken tok = new ShortToken();
        MintVault mv = new MintVault(tok);
        mv.mint(OWNER, 100e6);
        vm.prank(OWNER);
        mv.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(mv), 0, 0, _keys(pauseKey)));

        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);

        assertEq(tok.balanceOf(OWNER), 100e6, "the owner already holds the payout");
        assertEq(router.owed(OWNER, address(tok)), 100e6, "and it is also booked as owed");
        assertEq(router.totalOwed(address(tok)), 100e6, "totalOwed counts it");
        assertEq(tok.balanceOf(address(router)), 0, "with nothing behind it");

        // Every claim for this token reverts, genuine ones included, because safeTransfer reads the same 1 byte as failure.
        vm.expectRevert();
        router.claimOwed(OWNER, address(tok));
    }

    // ------------------------------------------------------------------ a gas-burning feed makes Stable-harbour exits expensive

    function test_gasBurningFeedMakesAStableHarbourExitCostTwentyTimesTheGas() public {
        MockERC20 a = new MockERC20(18);
        MockVault vA = new MockVault(a, 1e18);
        MockVault vB = new MockVault(new MockERC20(18), 1e18);
        swap.setRate(1e6);
        _feedAndRoute(address(a), address(new GasBurnFeed()));
        _feedAndRoute(address(vB.assetToken()), address(new MockFeed(1e8)));

        bytes32 id1 = _setup(address(0xA1A1), vA, 1e18, 1, 100);
        bytes32 id2 = _setup(address(0xA2A2), vA, 1e18, 1, 100);
        bytes32 id3 = _setup(address(0xA3A3), vB, 1e18, 1, 100);
        _fireAlarm();

        // Honest feed: a million gas is plenty.
        (bool okHonest, uint256 usedHonest) = _exitWithGas(id3, 1_000_000);
        assertTrue(okHonest, "honest feed exits at 1M gas (about 380k used)");

        // Burning feed: the same exit fails at 1M gas, because the self-staticcall into the feed eats 63/64 of what is left.
        (bool okLow,) = _exitWithGas(id1, 1_000_000);
        assertTrue(!okLow, "burner feed: 1M gas is not enough");
        assertEq(a.balanceOf(address(0xA1A1)), 0, "nothing paid");

        // It works if the sender supplies several million gas.
        (bool okHigh, uint256 usedHigh) = _exitWithGas(id2, 8_000_000);
        assertTrue(okHigh, "burner feed: 8M gas works (about 7.8M used)");
        assertEq(a.balanceOf(address(0xA2A2)), 1e18, "raw token delivered, swap skipped");
        assertTrue(usedHigh > usedHonest * 20, "the exit burned more than 20 times the honest gas");
    }

    function _feedAndRoute(address token, address feed) internal {
        vm.startPrank(ADMIN);
        router.setFeed(token, feed, 3600, 18);
        router.setRoute(token, abi.encodePacked(token, uint24(500), address(stable)));
        vm.stopPrank();
    }

    function _exitWithGas(bytes32 id, uint256 g) internal returns (bool ok, uint256 used) {
        uint256 g0 = gasleft();
        vm.prank(KEEPER);
        (ok,) = address(router).call{gas: g}(abi.encodeCall(router.exit, (id, pauseKey, 0)));
        used = g0 - gasleft();
    }

    // ------------------------------------------------------------------ untested ETH / WETH payout paths (all behave as documented)

    function _ethWorld(address wethAddr) internal returns (ExitRouter r, EthAdapter ad, MockERC20 share) {
        r = new ExitRouter(
            address(stable), wethAddr, address(swap), address(book), ADMIN, GUARD, address(stableFeed), 90_000,
            block.timestamp + 365 days
        );
        ad = new EthAdapter(address(r));
        vm.prank(ADMIN);
        r.setAdapter(address(ad), true);
        vm.deal(address(ad), 10 ether);
        share = new MockERC20(18);
    }

    function _ethParams(EthAdapter ad, MockERC20 share) internal pure returns (ExitRouter.ArmParams memory) {
        return ExitRouter.ArmParams({
            adapter: address(ad),
            target: address(share),
            tokenId: 0,
            harbour: 0,
            maxSlipBps: 0,
            termsHash: TERMS,
            keys: new bytes32[](0)
        });
    }

    function test_ethPayoutGoesStraightToAnEoaOwner() public {
        (ExitRouter r, EthAdapter ad, MockERC20 share) = _ethWorld(address(weth));
        share.mint(OWNER, 1 ether);
        vm.prank(OWNER);
        share.approve(address(r), type(uint256).max);
        vm.prank(OWNER);
        bytes32 id = r.arm(_ethParams(ad, share));
        vm.prank(OWNER);
        r.exit(id, bytes32(0), 0);
        assertEq(OWNER.balance, 1 ether, "ETH to the owner");
        assertEq(address(r).balance, 0, "nothing left");
    }

    function test_ownerThatRefusesEthIsPaidInWeth() public {
        Weth w = new Weth();
        (ExitRouter r, EthAdapter ad, MockERC20 share) = _ethWorld(address(w));
        Owner o = new Owner();
        share.mint(address(o), 1 ether);
        o.approve(address(share), address(r));
        bytes32 id = o.arm(r, _ethParams(ad, share));
        o.exitIt(r, id);
        assertEq(w.balanceOf(address(o)), 1 ether, "WETH to the owner");
        assertEq(address(r).balance, 0, "no ETH left");
        assertEq(r.totalOwed(address(w)), 0, "nothing owed");
    }

    function test_wethTransferFailureBooksWethOwedAndClaimWorks() public {
        Weth w = new Weth();
        (ExitRouter r, EthAdapter ad, MockERC20 share) = _ethWorld(address(w));
        Owner o = new Owner();
        share.mint(address(o), 1 ether);
        o.approve(address(share), address(r));
        bytes32 id = o.arm(r, _ethParams(ad, share));
        w.setBlocked(address(o), true);
        o.exitIt(r, id);
        assertEq(r.owed(address(o), address(w)), 1 ether, "WETH owed");
        assertEq(w.balanceOf(address(r)), 1 ether, "and backed");
        w.setBlocked(address(o), false);
        vm.prank(KEEPER);
        r.claimOwed(address(o), address(w));
        assertEq(w.balanceOf(address(o)), 1 ether, "claimed by a stranger's call, paid to the owner");
        assertEq(w.balanceOf(KEEPER), 0, "keeper got nothing");
        assertEq(r.totalOwed(address(w)), 0, "cleared");
    }

    function test_noUsableWethBooksEthOwedAndClaimsLater() public {
        // `weth` in Base is a plain token with no deposit(), and address(0) skips the WETH branch entirely.
        address[2] memory wethChoices = [address(weth), address(0)];
        for (uint256 i; i < 2; ++i) {
            (ExitRouter r, EthAdapter ad, MockERC20 share) = _ethWorld(wethChoices[i]);
            Owner o = new Owner();
            share.mint(address(o), 1 ether);
            o.approve(address(share), address(r));
            bytes32 id = o.arm(r, _ethParams(ad, share));
            o.exitIt(r, id);
            assertEq(r.owed(address(o), address(0)), 1 ether, "ETH owed");
            assertEq(address(r).balance, 1 ether, "backed");
            vm.expectRevert(ExitRouter.NothingOwed.selector); // the owner still refuses ETH: the claim reverts and changes nothing
            r.claimOwed(address(o), address(0));
            assertEq(r.owed(address(o), address(0)), 1 ether, "unchanged");
            o.setAccept(true);
            vm.prank(KEEPER);
            r.claimOwed(address(o), address(0));
            assertEq(address(o).balance, 1 ether, "paid");
            assertEq(r.totalOwed(address(0)), 0, "cleared");
        }
    }
}
