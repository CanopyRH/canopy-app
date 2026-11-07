// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitRouter} from "../src/ExitRouter.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {AdapterBase} from "../src/adapters/AdapterBase.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {IERC20} from "../src/interfaces/IExternal.sol";
import {INonfungiblePositionManager} from "../src/interfaces/IUniswapV3.sol";

interface V3ForkVm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address, uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
    function expectRevert(bytes4) external;
}

interface IPositionsFull {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(MintParams calldata p)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function approve(address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function totalSupply() external view returns (uint256);
    function tokenByIndex(uint256 index) external view returns (uint256);
}

interface IPoolSlot0 {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

/// @dev SwapRouter02's single-pool swap. No deadline field.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut);
}

interface IWETH9 {
    function deposit() external payable;
}

/// @notice Real Uniswap v3 positions on a live fork. Runs on Base or Robinhood Chain, skips anywhere else:
/// forge test --match-contract UniswapV3ForkTest --fork-url <rpc>
contract UniswapV3ForkTest {
    V3ForkVm internal constant vm = V3ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant OWNER = address(0xA11CE);
    address internal constant KEEPER = address(0xB0B);
    address internal constant ATTACKER = address(0xBAD);
    address internal constant TRADER = address(0x7EAD);
    uint256 internal constant PK_A = 0xA1;
    uint256 internal constant PK_B = 0xB2;
    uint24 internal constant FEE = 500;
    int24 internal constant SPACING = 10;

    // Per chain. token0 is WETH and token1 the stablecoin on both chains' WETH/stable 0.05% pools.
    address internal npm;
    address internal swapRouter;
    address internal weth;
    address internal stable;
    address internal stableFeed;
    address internal ethFeed; // zero where Canopy has no ETH feed yet
    address internal pool;

    ExitRouter internal router;
    AlarmBook internal book;
    UniswapV3Adapter internal adapter;
    bytes32 internal key;

    event log_named_uint(string key, uint256 val);
    event log_named_address(string key, address val);

    function _onChain() internal view returns (bool) {
        return block.chainid == 8453 || block.chainid == 4663;
    }

    function setUp() public {
        if (block.chainid == 8453) {
            npm = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
            swapRouter = 0x2626664c2603336E57B271c5C0b26F421741e481;
            weth = 0x4200000000000000000000000000000000000006;
            stable = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // USDC
            stableFeed = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
            ethFeed = 0xa4250cE1aA15Ff4cb5E5a8655293b65694e436Ed;
            pool = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
        } else if (block.chainid == 4663) {
            npm = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
            swapRouter = 0xCaf681a66D020601342297493863E78C959E5cb2;
            weth = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
            stable = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // USDG
            stableFeed = 0x8bEeE3503F6860D5dac4cE26b5eEe92982951c2e;
            pool = 0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a;
        } else {
            return;
        }
        address[] memory watchers = new address[](2);
        watchers[0] = vm.addr(PK_A);
        watchers[1] = vm.addr(PK_B);
        book = new AlarmBook(address(this), watchers);
        router = new ExitRouter(
            stable, weth, swapRouter, address(book), address(this), address(this), stableFeed, 90_000,
            block.timestamp + 365 days, new address[](0)
        );
        adapter = new UniswapV3Adapter(address(router), npm);
        router.setAdapter(address(adapter), true);
        key = book.register(
            AlarmBook.Detector({kind: AlarmBook.Kind.QUORUM, target: address(0xBA5E), threshold: 2, window: 0, a: 0, b: 0})
        );
    }

    // ---------------------------------------------------------------- helpers

    function _fire() internal {
        bytes32 ev = keccak256("evidence");
        uint64 dl = uint64(block.timestamp + 600);
        bytes32 d = book.attestDigest(key, ev, dl);
        (uint256 lo, uint256 hi) = vm.addr(PK_A) < vm.addr(PK_B) ? (PK_A, PK_B) : (PK_B, PK_A);
        address[] memory s = new address[](2);
        bytes[] memory g = new bytes[](2);
        s[0] = vm.addr(lo);
        s[1] = vm.addr(hi);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(lo, d);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(hi, d);
        g[0] = abi.encodePacked(r1, s1, v1);
        g[1] = abi.encodePacked(r2, s2, v2);
        book.fireByQuorum(key, ev, dl, s, g);
    }

    function _tick() internal view returns (int24 t) {
        (, int24 tick,,,,,) = IPoolSlot0(pool).slot0();
        t = (tick / SPACING) * SPACING;
        if (tick < 0 && tick % SPACING != 0) t -= SPACING;
    }

    function _swap(address who, address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256 out) {
        vm.startPrank(who);
        IERC20(tokenIn).approve(swapRouter, amountIn);
        out = ISwapRouter02(swapRouter).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(tokenIn, tokenOut, FEE, who, amountIn, 0, 0)
        );
        vm.stopPrank();
    }

    /// @dev Wraps ETH, buys some stablecoin on the pool and mints a position over [lo, hi] ticks from the current one.
    function _mint(address who, int24 lo, int24 hi) internal returns (uint256 id, uint128 liquidity) {
        vm.deal(who, 30 ether);
        vm.prank(who);
        IWETH9(weth).deposit{value: 20 ether}();
        _swap(who, weth, stable, 5 ether);
        int24 t = _tick();
        vm.startPrank(who);
        IERC20(weth).approve(npm, type(uint256).max);
        IERC20(stable).approve(npm, type(uint256).max);
        (id, liquidity,,) = IPositionsFull(npm).mint(
            IPositionsFull.MintParams({
                token0: weth,
                token1: stable,
                fee: FEE,
                tickLower: t + lo,
                tickUpper: t + hi,
                amount0Desired: 5 ether,
                amount1Desired: IERC20(stable).balanceOf(who),
                amount0Min: 0,
                amount1Min: 0,
                recipient: who,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
    }

    function _arm(address who, uint256 id, uint8 harbour, uint16 slip) internal returns (bytes32 posId) {
        vm.prank(who);
        IPositionsFull(npm).approve(address(router), id);
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = key;
        vm.prank(who);
        posId = router.arm(
            ExitRouter.ArmParams({
                adapter: address(adapter),
                target: npm,
                tokenId: id,
                harbour: harbour,
                maxSlipBps: slip,
                termsHash: keccak256("terms-v1"),
                keys: keys,
                swaps: _lpSwaps(harbour)
            })
        );
    }

    function _lpSwaps(uint8 harbour) internal view returns (ExitRouter.SwapLeg[] memory legs) {
        legs = new ExitRouter.SwapLeg[](harbour == 1 ? 1 : 0);
        if (legs.length != 0) legs[0] = ExitRouter.SwapLeg(weth, ethFeed, 3600, 18, abi.encodePacked(weth, FEE, stable));
    }

    function _pos(uint256 id) internal view returns (INonfungiblePositionManager.Position memory) {
        return INonfungiblePositionManager(npm).positions(id);
    }

    /// @dev What the owner would get from removing the liquidity alone, without fees, measured and rolled back.
    function _principal(address who, uint256 id) internal returns (uint256 a0, uint256 a1) {
        uint256 snap = vm.snapshotState();
        uint128 l = _pos(id).liquidity; // read first: a prank applies to the next call only
        vm.prank(who);
        (a0, a1) = INonfungiblePositionManager(npm).decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams(id, l, 0, 0, block.timestamp)
        );
        vm.revertToState(snap);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20(token).balanceOf(who);
    }

    function _assertEmptiedAndReturned(address owner, uint256 id, address t0, address t1) internal view {
        INonfungiblePositionManager.Position memory p = _pos(id);
        require(p.liquidity == 0, "liquidity left");
        require(p.tokensOwed0 == 0 && p.tokensOwed1 == 0, "tokens left owed in the NFT");
        require(IPositionsFull(npm).ownerOf(id) == owner, "NFT back with the owner");
        require(_bal(t0, address(router)) == 0 && _bal(t1, address(router)) == 0, "router residue");
        require(_bal(t0, address(adapter)) == 0 && _bal(t1, address(adapter)) == 0, "adapter residue");
    }

    // ---------------------------------------------------------------- exits

    function test_v3fork_ownerExitNow_inRange() public {
        if (!_onChain()) return;
        (uint256 id,) = _mint(OWNER, -600, 600);
        bytes32 posId = _arm(OWNER, id, 0, 0);
        (uint256 p0, uint256 p1) = _principal(OWNER, id);
        require(p0 > 0 && p1 > 0, "in range holds both tokens");
        uint256 w = _bal(weth, OWNER);
        uint256 s = _bal(stable, OWNER);
        vm.prank(OWNER);
        router.exit(posId, bytes32(0), 0);
        require(_bal(weth, OWNER) - w >= p0, "all WETH");
        require(_bal(stable, OWNER) - s >= p1, "all stablecoin");
        _assertEmptiedAndReturned(OWNER, id, weth, stable);
        emit log_named_uint("WETH milli out", (_bal(weth, OWNER) - w) / 1e15);
        emit log_named_uint("stable out", (_bal(stable, OWNER) - s) / 1e6);
    }

    function test_v3fork_keeperExit_paysOnlyOwner() public {
        if (!_onChain()) return;
        (uint256 id,) = _mint(OWNER, -600, 600);
        bytes32 posId = _arm(OWNER, id, 0, 0);
        _fire();
        uint256 w = _bal(weth, OWNER);
        uint256 s = _bal(stable, OWNER);
        uint256 kw = _bal(weth, KEEPER);
        uint256 ks = _bal(stable, KEEPER);
        vm.prank(KEEPER);
        router.exit(posId, key, 0);
        require(_bal(weth, OWNER) > w && _bal(stable, OWNER) > s, "owner paid both tokens");
        require(_bal(weth, KEEPER) == kw && _bal(stable, KEEPER) == ks, "keeper paid nothing");
        _assertEmptiedAndReturned(OWNER, id, weth, stable);
    }

    function test_v3fork_disarm_stopsKeeper() public {
        if (!_onChain()) return;
        (uint256 id, uint128 l) = _mint(OWNER, -600, 600);
        bytes32 posId = _arm(OWNER, id, 0, 0);
        _fire();
        vm.prank(OWNER);
        router.disarm(posId);
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotArmed.selector);
        router.exit(posId, key, 0);
        require(_pos(id).liquidity == l, "untouched");
        require(IPositionsFull(npm).ownerOf(id) == OWNER, "still the owner's");
    }

    function test_v3fork_outOfRange_onlyWeth() public {
        if (!_onChain()) return;
        (uint256 id,) = _mint(OWNER, 1000, 1600); // above the price: all token0
        bytes32 posId = _arm(OWNER, id, 0, 0);
        (uint256 p0, uint256 p1) = _principal(OWNER, id);
        require(p0 > 0 && p1 == 0, "out of range holds WETH only");
        _fire();
        uint256 w = _bal(weth, OWNER);
        uint256 s = _bal(stable, OWNER);
        vm.prank(KEEPER);
        router.exit(posId, key, 0);
        require(_bal(weth, OWNER) - w >= p0, "WETH out");
        require(_bal(stable, OWNER) == s, "no stablecoin");
        _assertEmptiedAndReturned(OWNER, id, weth, stable);
    }

    function test_v3fork_feesOwed_paidWithPrincipal() public {
        if (!_onChain()) return;
        (uint256 id,) = _mint(OWNER, -20, 30);
        bytes32 posId = _arm(OWNER, id, 0, 0);
        // A trader goes round trip through the position's range, so it earns fees in both tokens.
        vm.deal(TRADER, 60 ether);
        vm.prank(TRADER);
        IWETH9(weth).deposit{value: 50 ether}();
        uint256 got = _swap(TRADER, weth, stable, 20 ether);
        _swap(TRADER, stable, weth, got);
        (uint256 p0, uint256 p1) = _principal(OWNER, id);
        _fire();
        uint256 w = _bal(weth, OWNER);
        uint256 s = _bal(stable, OWNER);
        vm.prank(KEEPER);
        router.exit(posId, key, 0);
        uint256 out0 = _bal(weth, OWNER) - w;
        uint256 out1 = _bal(stable, OWNER) - s;
        emit log_named_uint("WETH fee wei", out0 - p0);
        emit log_named_uint("stable fee units", out1 - p1);
        require(out0 > p0 && out1 > p1, "fees in both tokens on top of principal");
        _assertEmptiedAndReturned(OWNER, id, weth, stable);
    }

    function test_v3fork_harbourStable_swapOrRaw() public {
        if (!_onChain() || ethFeed == address(0)) return;
        (uint256 id,) = _mint(OWNER, -600, 600);
        bytes32 posId = _arm(OWNER, id, 1, 1000);
        (uint256 p0, uint256 p1) = _principal(OWNER, id);
        (bool ok, uint256 minOut) = router.quoteMinOut(ethFeed, 3600, 18, p0, 100);
        require(ok, "quote");
        _fire();
        uint256 w = _bal(weth, OWNER);
        uint256 s = _bal(stable, OWNER);
        vm.prank(KEEPER);
        router.exit(posId, key, 0);
        uint256 raw = _bal(weth, OWNER) - w;
        uint256 got = _bal(stable, OWNER) - s;
        emit log_named_uint("raw WETH milli", raw / 1e15);
        emit log_named_uint("stable out", got / 1e6);
        // The keeper's swap fills at the 1% oracle floor or better, or is skipped and the WETH arrives raw.
        if (raw == 0) require(got >= p1 + minOut, "swap at or above the floor");
        else require(raw >= p0 && got >= p1, "skipped swap delivers everything raw");
        require(IERC20(weth).allowance(address(router), swapRouter) == 0, "approval cleared");
        _assertEmptiedAndReturned(OWNER, id, weth, stable);
    }

    /// @dev Positions minted by real users, whatever their pair: the newest few with liquidity, each exited by a
    /// keeper on a snapshot.
    function test_v3fork_realPositions_keeperExit() public {
        if (!_onChain()) return;
        uint256 n = IPositionsFull(npm).totalSupply();
        uint256 done;
        for (uint256 i = n; i > 0 && i > n - 400 && done < 5; --i) {
            uint256 id = IPositionsFull(npm).tokenByIndex(i - 1);
            INonfungiblePositionManager.Position memory p = _pos(id);
            if (p.liquidity == 0) continue;
            address owner = IPositionsFull(npm).ownerOf(id);
            uint256 snap = vm.snapshotState();
            bytes32 posId = _arm(owner, id, 0, 0);
            _fire();
            uint256 b0 = _bal(p.token0, owner);
            uint256 b1 = _bal(p.token1, owner);
            vm.prank(KEEPER);
            router.exit(posId, key, 0);
            require(_bal(p.token0, owner) >= b0 && _bal(p.token1, owner) >= b1, "owner never loses");
            require(_bal(p.token0, owner) + _bal(p.token1, owner) > b0 + b1, "something came out");
            _assertEmptiedAndReturned(owner, id, p.token0, p.token1);
            emit log_named_uint("exited real position", id);
            vm.revertToState(snap);
            ++done;
        }
        require(done == 5, "found too few live positions");
    }

    // ---------------------------------------------------------------- attacks

    function test_v3fork_attack_wrongOwnerCannotArm() public {
        if (!_onChain()) return;
        (uint256 id,) = _mint(OWNER, -600, 600);
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = key;
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.NotOwner.selector);
        router.arm(
            ExitRouter.ArmParams({
                adapter: address(adapter),
                target: npm,
                tokenId: id,
                harbour: 0,
                maxSlipBps: 0,
                termsHash: keccak256("terms-v1"),
                keys: keys,
                swaps: new ExitRouter.SwapLeg[](0)
            })
        );
    }

    function test_v3fork_attack_unlistedAdapterAndDirectUnwind() public {
        if (!_onChain()) return;
        (uint256 id,) = _mint(OWNER, -600, 600);
        UniswapV3Adapter rogue = new UniswapV3Adapter(address(router), npm);
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = key;
        vm.prank(OWNER);
        vm.expectRevert(ExitRouter.NotSupported.selector);
        router.arm(
            ExitRouter.ArmParams({
                adapter: address(rogue),
                target: npm,
                tokenId: id,
                harbour: 0,
                maxSlipBps: 0,
                termsHash: keccak256("terms-v1"),
                keys: keys,
                swaps: new ExitRouter.SwapLeg[](0)
            })
        );
        vm.prank(ATTACKER);
        vm.expectRevert(AdapterBase.OnlyRouter.selector);
        adapter.unwind(npm, id);
    }

    function test_v3fork_attack_strangerNeedsLiveAlarm() public {
        if (!_onChain()) return;
        (uint256 id,) = _mint(OWNER, -600, 600);
        bytes32 posId = _arm(OWNER, id, 0, 0);
        vm.prank(ATTACKER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(posId, key, 0);
    }

    function test_v3fork_positionManagerIsUniswapV3() public view {
        if (!_onChain()) return;
        require(INonfungiblePositionManager(npm).WETH9() == weth, "NPM WETH is the router's WETH");
        require(INonfungiblePositionManager(npm).factory() != address(0), "factory");
    }
}
