// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {IMorphoGuard} from "../interfaces/IMorphoGuard.sol";
import {RiskReader} from "./RiskReaders.sol";
import {FullMath} from "../lib/FullMath.sol";

interface IMorphoRateView {
    function borrowRateView(IMorphoGuard.MarketParams memory, IMorphoGuard.Market memory)
        external
        view
        returns (uint256);
}

interface IMorphoPrice {
    function price() external view returns (uint256);
}

interface IFeedHealth {
    function value() external view returns (uint256);
}

/// @notice Remaining borrowing capacity in bps + 1. A lower answer means less liquidation headroom.
/// @dev Estimates accrued debt using Morpho's three-term interest formula. Requires a separately reviewed
/// freshness reader: price() alone says nothing about oracle age or pause state. Failure is UNKNOWN.
contract MorphoHeadroomReader is RiskReader {
    IMorphoGuard public immutable MORPHO;
    bytes32 public immutable MARKET;
    address public immutable OWNER;
    IFeedHealth public immutable HEALTH;

    constructor(address morpho, bytes32 marketId, address owner, address health) {
        if (morpho.code.length == 0 || health.code.length == 0 || owner == address(0)) revert BadConfiguration();
        IMorphoGuard.MarketParams memory p = IMorphoGuard(morpho).idToMarketParams(marketId);
        if (keccak256(abi.encode(p)) != marketId || p.oracle.code.length == 0 || p.lltv == 0 || p.lltv >= 1e18) {
            revert BadConfiguration();
        }
        MORPHO = IMorphoGuard(morpho);
        MARKET = marketId;
        OWNER = owner;
        HEALTH = IFeedHealth(health);
    }

    function value() public view override returns (uint256) {
        IMorphoGuard.Position memory position = MORPHO.position(MARKET, OWNER);
        if (position.borrowShares == 0) return 10001;
        if (HEALTH.value() != 2) revert InvalidReading();
        IMorphoGuard.MarketParams memory p = MORPHO.idToMarketParams(MARKET);
        IMorphoGuard.Market memory m = MORPHO.market(MARKET);
        if (m.lastUpdate == 0 || m.lastUpdate > block.timestamp || block.timestamp - m.lastUpdate > 365 days) {
            revert InvalidReading();
        }
        uint256 borrowed = m.totalBorrowAssets;
        if (p.irm != address(0) && block.timestamp > m.lastUpdate) {
            uint256 rate = IMorphoRateView(p.irm).borrowRateView(p, m);
            uint256 x = rate * (block.timestamp - m.lastUpdate);
            uint256 square = FullMath.mulDiv(x, x, 2e18);
            uint256 compounded = x + square + FullMath.mulDiv(square, x, 3e18);
            borrowed += FullMath.mulDiv(borrowed, compounded, 1e18);
        }
        if (borrowed > type(uint128).max) revert InvalidReading();
        uint256 debt = FullMath.mulDiv(position.borrowShares, borrowed + 1, uint256(m.totalBorrowShares) + 1_000_000);
        if (mulmod(position.borrowShares, borrowed + 1, uint256(m.totalBorrowShares) + 1_000_000) > 0) debt++;
        uint256 price = IMorphoPrice(p.oracle).price();
        if (price == 0) revert InvalidReading();
        uint256 capacity = FullMath.mulDiv(FullMath.mulDiv(position.collateral, price, 1e36), p.lltv, 1e18);
        if (capacity == 0 || debt >= capacity) return 1;
        return FullMath.mulDiv(capacity - debt, 10000, capacity) + 1;
    }
}
