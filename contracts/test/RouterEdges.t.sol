// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {IExitAdapter} from "../src/interfaces/IExitAdapter.sol";
import {MockERC20, MockVault, MockFeed} from "./Mocks.sol";
import {SafeTransferLib} from "../src/lib/SafeTransferLib.sol";

/// @dev A token whose transfer returns one byte instead of a 32-byte bool. While `stuck` is set the transfer moves nothing
/// but still returns the same byte, so only the balance tells the two apart.
contract ShortToken is MockERC20 {
    bool public stuck;

    constructor() MockERC20(6) {}

    function setStuck(bool s) external {
        stuck = s;
    }

    function transfer(address to, uint256 a) public override returns (bool) {
        if (!stuck) _move(msg.sender, to, a);
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

/// @dev Answers latestRoundData honestly, then burns every unit of gas in decimals().
contract DecimalsBurnFeed {
    function decimals() external pure returns (uint8) {
        assembly {
            invalid()
        }
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 1e8, block.timestamp, block.timestamp, 1);
    }
}

/// @dev Returns a 60 kB payload from every call, to make a naive caller pay to copy it.
contract ReturnBombFeed {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    fallback() external {
        assembly {
            return(0, 60000)
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

/// @notice Edge behaviour of ExitRouter. In v1 the first two sections pinned documented problems (A2-06, A2-07); in v2 they
/// assert the fixes. The ETH and WETH payout paths follow.
contract RouterEdgesTest is Base {
    // ------------------------------------------------------------------ A2-06: a 1-byte return follows the balance

    function _shortWorld() internal returns (ShortToken tok, bytes32 id) {
        tok = new ShortToken();
        MintVault mv = new MintVault(tok);
        mv.mint(OWNER, 100e6);
        vm.prank(OWNER);
        mv.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        id = router.arm(_params(address(mv), 0, 0, _keys(pauseKey)));
    }

    /// v1: the owner received the tokens and they were also booked as owed, with nothing behind the record.
    /// v2: the transfer moved the tokens, so it counts as paid and nothing is owed.
    function test_oneByteReturnToken_thatMovesIsPaidOnce_andNotBookedAsOwed() public {
        (ShortToken tok, bytes32 id) = _shortWorld();
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(tok.balanceOf(OWNER), 100e6, "the owner holds the payout");
        assertEq(router.owed(OWNER, address(tok)), 0, "nothing booked as owed");
        assertEq(router.totalOwed(address(tok)), 0, "totalOwed is zero");
        assertEq(tok.balanceOf(address(router)), 0, "nothing left in the router");
    }

    /// The same token, when its transfer moves nothing: the payout is booked as owed, backed, and claimable once it moves.
    function test_oneByteReturnToken_thatDoesntMoveIsBookedAsOwed_andClaimable() public {
        (ShortToken tok, bytes32 id) = _shortWorld();
        tok.setStuck(true);
        vm.prank(OWNER);
        router.exit(id, bytes32(0), 0);
        assertEq(tok.balanceOf(OWNER), 0, "nothing reached the owner");
        assertEq(router.owed(OWNER, address(tok)), 100e6, "booked as owed");
        assertEq(tok.balanceOf(address(router)), 100e6, "and backed");
        vm.expectRevert(abi.encodeWithSelector(SafeTransferLib.TransferFailed.selector, address(tok)));
        router.claimOwed(OWNER, address(tok)); // still stuck: the claim fails and changes nothing
        tok.setStuck(false);
        vm.prank(KEEPER);
        router.claimOwed(OWNER, address(tok));
        assertEq(tok.balanceOf(OWNER), 100e6, "claimed for the owner");
        assertEq(router.totalOwed(address(tok)), 0, "cleared");
    }

    // ------------------------------------------------------------------ A2-07: a hostile feed costs bounded gas

    function _burnWorld(address feedA) internal returns (MockERC20 a, bytes32 id1, bytes32 id3) {
        a = new MockERC20(18);
        MockVault vA = new MockVault(a, 1e18);
        MockVault vB = new MockVault(new MockERC20(18), 1e18);
        swap.setRate(1e6);
        id1 = _setupSwap(address(0xA1A1), vA, 1e18, 100, _legs(_leg(address(a), feedA)));
        id3 = _setupSwap(
            address(0xA3A3), vB, 1e18, 100, _legs(_leg(address(vB.assetToken()), address(new MockFeed(1e8))))
        );
        _fireAlarm();
    }

    /// v1: a feed that burns all its gas made a Stable-harbour exit fail at 1M gas and cost over 20 times the honest gas.
    /// v2: each feed read gets at most FEED_READ_GAS, so the same exit works at 1M gas for a bounded extra cost.
    function test_gasBurningFeed_costsBoundedGas_andTheRawTokenIsPaid() public {
        (MockERC20 a, bytes32 id1, bytes32 id3) = _burnWorld(address(new GasBurnFeed()));
        (bool okHonest, uint256 usedHonest) = _exitWithGas(id3, 1_000_000);
        assertTrue(okHonest, "honest feed exits at 1M gas");
        (bool okBurn, uint256 usedBurn) = _exitWithGas(id1, 1_000_000);
        assertTrue(okBurn, "burner feed: 1M gas is enough");
        assertEq(a.balanceOf(address(0xA1A1)), 1e18, "raw token delivered, swap skipped");
        assertTrue(usedBurn < usedHonest + 2 * router.FEED_READ_GAS(), "at most one capped read more than honest");
    }

    function test_feedBurningGasInDecimals_isCappedToo() public {
        (MockERC20 a, bytes32 id1, bytes32 id3) = _burnWorld(address(new DecimalsBurnFeed()));
        (, uint256 usedHonest) = _exitWithGas(id3, 1_000_000);
        (bool ok, uint256 used) = _exitWithGas(id1, 1_000_000);
        assertTrue(ok, "exits");
        assertEq(a.balanceOf(address(0xA1A1)), 1e18, "raw");
        assertTrue(used < usedHonest + 2 * router.FEED_READ_GAS(), "bounded");
    }

    function test_returnBombFeed_isNotCopied() public {
        (MockERC20 a, bytes32 id1, bytes32 id3) = _burnWorld(address(new ReturnBombFeed()));
        (, uint256 usedHonest) = _exitWithGas(id3, 1_000_000);
        (bool ok, uint256 used) = _exitWithGas(id1, 1_000_000);
        assertTrue(ok, "exits");
        assertEq(a.balanceOf(address(0xA1A1)), 1e18, "raw: the bomb's answer is not a usable price");
        assertTrue(used < usedHonest + 2 * router.FEED_READ_GAS(), "bounded");
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
            block.timestamp + 365 days, new address[](0)
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
            keys: new bytes32[](0),
            swaps: new ExitRouter.SwapLeg[](0)
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
