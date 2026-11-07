// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IExitAdapter} from "../interfaces/IExitAdapter.sol";
import {INonfungiblePositionManager} from "../interfaces/IUniswapV3.sol";
import {AdapterBase} from "./AdapterBase.sol";

/// @title UniswapV3Adapter
/// @notice Exits Uniswap v3 liquidity positions (NonfungiblePositionManager NFTs), principal and fees.
/// @dev The router moves the NFT here with transferFrom, calls unwind, then requires the NFT back and passes it
/// to the owner. unwind removes all liquidity and collects both tokens straight to the router, so no token ever
/// sits in this contract, and hands the emptied NFT back. It is not burned: the router needs it back, and the
/// owner keeps it (an empty position costs nothing and can be refilled or burned later).
///
/// Liquidity is withdrawn at the pool's execution price with zero per-token minima. A price move changes the
/// output mix; this path does not enforce an external valuation or prevent adverse price movement. The separate
/// optional stablecoin swaps use the owner's oracle bounds in ExitRouter and may fall back to raw tokens.
///
/// Output tokens are the pool's token0 and token1 as ERC-20s (WETH stays WETH: the pool never pays native ETH).
contract UniswapV3Adapter is IExitAdapter, AdapterBase {
    INonfungiblePositionManager public immutable POSITIONS;

    uint128 internal constant ALL = type(uint128).max;

    error OutOfGas();
    error WrongTarget();

    constructor(address router, address positionManager) AdapterBase(router) {
        POSITIONS = INonfungiblePositionManager(positionManager);
    }

    function positionAsset(address target) external view returns (address asset, bool isNft) {
        if (target != address(POSITIONS)) revert WrongTarget();
        return (target, true);
    }

    function outputs(address target, uint256 tokenId) external view returns (address[] memory tokens) {
        if (target != address(POSITIONS)) revert WrongTarget();
        INonfungiblePositionManager.Position memory p = POSITIONS.positions(tokenId);
        tokens = new address[](2);
        tokens[0] = p.token0;
        tokens[1] = p.token1;
    }

    /// @dev A position with no liquidity skips straight to collect, which still pays any fees owed. Collect sends
    /// to the router, which measures what arrived, so a fee-on-transfer token simply pays less.
    function unwind(address target, uint256 tokenId) external onlyRouter {
        if (target != address(POSITIONS)) revert WrongTarget();
        uint128 liquidity = POSITIONS.positions(tokenId).liquidity;
        if (liquidity > 0) {
            POSITIONS.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: tokenId,
                    liquidity: liquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp
                })
            );
        }
        // One token that refuses to move (paused, or blocking the router) must not trap the other. What can't
        // be collected stays owed inside the NFT, which goes back to the owner.
        if (!_collect(tokenId, ALL, ALL)) {
            _collect(tokenId, ALL, 0);
            _collect(tokenId, 0, ALL);
        }
        POSITIONS.transferFrom(address(this), ROUTER, tokenId);
    }

    /// @dev A caller who sends too little gas could make a collect fail on purpose and leave tokens in the NFT.
    /// A failure that used up the gas reverts the whole exit instead.
    function _collect(uint256 tokenId, uint128 max0, uint128 max1) internal returns (bool ok) {
        uint256 g = gasleft();
        try POSITIONS.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: ROUTER,
                amount0Max: max0,
                amount1Max: max1
            })
        ) {
            ok = true;
        } catch {
            if (gasleft() <= g / 63) revert OutOfGas();
        }
    }
}
