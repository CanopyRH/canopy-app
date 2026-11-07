// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Uniswap v3 NonfungiblePositionManager, only what the adapter uses. Kept out of IExternal.sol so the
/// live contracts compile to the same bytecode.
interface INonfungiblePositionManager {
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

    /// @dev All fields are static, so this decodes the same bytes as the 12-value tuple the contract returns.
    struct Position {
        uint96 nonce;
        address operator;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    function positions(uint256 tokenId) external view returns (Position memory);

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function transferFrom(address from, address to, uint256 tokenId) external;

    function factory() external view returns (address);

    function WETH9() external view returns (address);
}
