// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {IExitAdapter} from "../interfaces/IExitAdapter.sol";
import {AdapterBase} from "./AdapterBase.sol";

/// @notice Minimal official v4 PositionManager ABI. Currency is address; PositionInfo is uint256.
interface IV4Positions {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }
    function getPoolAndPositionInfo(uint256) external view returns (PoolKey memory, uint256);
    function getPositionLiquidity(uint256) external view returns (uint128);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @notice Prepared adapter for hookless Uniswap v4 positions only. No deployed manager or activation is implied.
/// @dev All liquidity and accrued fees go directly to ROUTER, including native currency; NFT returns emptied.
/// Per-token minima are zero, so pool price changes change the payout mix. Stable swaps remain separately bounded.
/// V4 settlement is atomic: a blocked currency reverts the entire exit, preserving the original NFT/position.
contract UniswapV4Adapter is IExitAdapter, AdapterBase {
    IV4Positions public immutable POSITIONS;
    error WrongTarget();
    error UnsupportedHook();
    error InvalidPool();

    constructor(address router, address manager) AdapterBase(router) {
        if (manager.code.length == 0) revert WrongTarget();
        POSITIONS = IV4Positions(manager);
    }

    function positionAsset(address target) external view returns (address, bool) {
        if (target != address(POSITIONS)) revert WrongTarget();
        return (target, true);
    }

    function _pool(address target, uint256 tokenId) private view returns (IV4Positions.PoolKey memory p) {
        if (target != address(POSITIONS)) revert WrongTarget();
        (p,) = POSITIONS.getPoolAndPositionInfo(tokenId);
        if (p.hooks != address(0)) revert UnsupportedHook();
        if (p.currency0 >= p.currency1 || p.tickSpacing <= 0) revert InvalidPool();
    }

    function outputs(address target, uint256 tokenId) external view returns (address[] memory tokens) {
        IV4Positions.PoolKey memory p = _pool(target, tokenId);
        tokens = new address[](2);
        tokens[0] = p.currency0;
        tokens[1] = p.currency1;
    }

    function unwind(address target, uint256 tokenId) external onlyRouter {
        IV4Positions.PoolKey memory p = _pool(target, tokenId);
        bytes[] memory params = new bytes[](2);
        // Official Actions.DECREASE_LIQUIDITY (0x01), TAKE_PAIR (0x11). Zero decrease also collects accrued fees.
        params[0] =
            abi.encode(tokenId, uint256(POSITIONS.getPositionLiquidity(tokenId)), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(p.currency0, p.currency1, ROUTER);
        POSITIONS.modifyLiquidities(abi.encode(hex"0111", params), block.timestamp);
        POSITIONS.transferFrom(address(this), ROUTER, tokenId);
    }
}
