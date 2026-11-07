// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal Morpho Blue interface; upstream: morpho-org/morpho-blue/src/interfaces/IMorpho.sol.
interface IMorphoGuard {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    struct Position {
        uint256 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    struct Market {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        uint128 fee;
    }
    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
    function position(bytes32 id, address owner) external view returns (Position memory);
    function market(bytes32 id) external view returns (Market memory);
    function accrueInterest(MarketParams memory params) external;
    function repay(MarketParams memory params, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256 assetsRepaid, uint256 sharesRepaid);
    function withdrawCollateral(MarketParams memory params, uint256 assets, address onBehalf, address receiver) external;
}
