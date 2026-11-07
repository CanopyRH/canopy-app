// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockERC20} from "./Mocks.sol";
import {INonfungiblePositionManager} from "../src/interfaces/IUniswapV3.sol";

/// @dev NonfungiblePositionManager-shaped: holds each position's tokens and pays them out the way the real one
/// does. Liquidity is worth a fixed amount of each token, set at mint; fees are added as owed amounts.
contract MockPositionManager {
    struct Pos {
        address token0;
        address token1;
        uint128 liquidity;
        uint256 principal0;
        uint256 principal1;
        uint128 owed0;
        uint128 owed1;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    mapping(uint256 => Pos) internal _pos;
    mapping(uint256 => address) internal _owner;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    uint256 public nextId = 1;
    address public WETH9;
    bool public burnGas;
    uint256 internal _sink;

    function mint(address to, MockERC20 t0, MockERC20 t1, uint128 liquidity, uint256 a0, uint256 a1)
        external
        returns (uint256 id)
    {
        id = nextId++;
        t0.mint(address(this), a0);
        t1.mint(address(this), a1);
        _pos[id] = Pos(address(t0), address(t1), liquidity, a0, a1, 0, 0);
        _owner[id] = to;
    }

    function addFees(uint256 id, uint128 f0, uint128 f1) external {
        Pos storage p = _pos[id];
        MockERC20(p.token0).mint(address(this), f0);
        MockERC20(p.token1).mint(address(this), f1);
        p.owed0 += f0;
        p.owed1 += f1;
    }

    function setWETH9(address w) external {
        WETH9 = w;
    }

    function setBurnGas(bool b) external {
        burnGas = b;
    }

    function ownerOf(uint256 id) public view returns (address o) {
        o = _owner[id];
        require(o != address(0), "invalid token");
    }

    function approve(address to, uint256 id) external {
        require(msg.sender == ownerOf(id), "not owner");
        getApproved[id] = to;
    }

    function setApprovalForAll(address op, bool b) external {
        isApprovedForAll[msg.sender][op] = b;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf(id) == from, "wrong from");
        require(_authorized(id), "not approved");
        getApproved[id] = address(0); // cleared on every transfer, as in the real ERC-721
        _owner[id] = to;
    }

    function positions(uint256 id) external view returns (INonfungiblePositionManager.Position memory r) {
        Pos memory p = _pos[id];
        require(p.token0 != address(0), "Invalid token ID");
        r.token0 = p.token0;
        r.token1 = p.token1;
        r.fee = 500;
        r.tickLower = -10;
        r.tickUpper = 10;
        r.liquidity = p.liquidity;
        r.tokensOwed0 = p.owed0;
        r.tokensOwed1 = p.owed1;
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata d) external payable returns (uint256 a0, uint256 a1) {
        require(_authorized(d.tokenId), "Not approved");
        require(block.timestamp <= d.deadline, "Transaction too old");
        Pos storage p = _pos[d.tokenId];
        require(d.liquidity > 0 && d.liquidity <= p.liquidity, "liquidity");
        a0 = (p.principal0 * d.liquidity) / p.liquidity;
        a1 = (p.principal1 * d.liquidity) / p.liquidity;
        require(a0 >= d.amount0Min && a1 >= d.amount1Min, "Price slippage check");
        p.principal0 -= a0;
        p.principal1 -= a1;
        p.liquidity -= d.liquidity;
        p.owed0 += uint128(a0);
        p.owed1 += uint128(a1);
    }

    function collect(CollectParams calldata c) external payable returns (uint256 a0, uint256 a1) {
        if (burnGas) {
            while (true) {
                _sink++;
            }
        }
        require(_authorized(c.tokenId), "Not approved");
        require(c.amount0Max > 0 || c.amount1Max > 0, "max");
        Pos storage p = _pos[c.tokenId];
        a0 = c.amount0Max < p.owed0 ? c.amount0Max : p.owed0;
        a1 = c.amount1Max < p.owed1 ? c.amount1Max : p.owed1;
        p.owed0 -= uint128(a0);
        p.owed1 -= uint128(a1);
        if (a0 > 0) MockERC20(p.token0).transfer(c.recipient, a0);
        if (a1 > 0) MockERC20(p.token1).transfer(c.recipient, a1);
    }

    function _authorized(uint256 id) internal view returns (bool) {
        address o = ownerOf(id);
        return msg.sender == o || getApproved[id] == msg.sender || isApprovedForAll[o][msg.sender];
    }
}

/// @dev Keeps 1% of every transfer.
contract FeeOnTransferToken is MockERC20 {
    constructor() MockERC20(18) {}

    function transfer(address to, uint256 a) public override returns (bool) {
        uint256 fee = a / 100;
        _move(msg.sender, to, a - fee);
        _burn(msg.sender, fee);
        return true;
    }
}

/// @dev Calls back into the router, the adapter and the position manager on every transfer, and records whether
/// each attempt got through. It never reverts itself, so the outcome survives the exit.
contract CallbackToken is MockERC20 {
    address public router;
    address public adapter;
    address public npm;
    bytes32 public victimPos;
    bytes32 public liveKey;
    address public victim;
    uint256 public tokenId;
    bool public armed;
    uint256 public attempts;
    uint256 public successes;

    constructor() MockERC20(18) {}

    function arm(address r, address a, address n, bytes32 p, bytes32 k, address v, uint256 id) external {
        router = r;
        adapter = a;
        npm = n;
        victimPos = p;
        liveKey = k;
        victim = v;
        tokenId = id;
        armed = true;
    }

    function transfer(address to, uint256 a) public override returns (bool) {
        if (armed) {
            armed = false;
            _try(router, abi.encodeWithSignature("exit(bytes32,bytes32,uint256)", victimPos, liveKey, uint256(0)));
            _try(router, abi.encodeWithSignature("claimOwed(address,address)", victim, address(this)));
            _try(adapter, abi.encodeWithSignature("unwind(address,uint256)", npm, tokenId));
            _try(npm, abi.encodeWithSignature("transferFrom(address,address,uint256)", adapter, address(this), tokenId));
            _try(
                npm,
                abi.encodeWithSignature(
                    "collect((uint256,address,uint128,uint128))", tokenId, address(this), type(uint128).max, type(uint128).max
                )
            );
        }
        return super.transfer(to, a);
    }

    function _try(address to, bytes memory d) internal {
        attempts++;
        (bool ok,) = to.call(d);
        if (ok) successes++;
    }
}
