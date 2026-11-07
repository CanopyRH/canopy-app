// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {RiskReader} from "./RiskReaders.sol";
import {IERC20, IAggregatorV3} from "../interfaces/IExternal.sol";
import {FullMath} from "../lib/FullMath.sol";

interface IObservedPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function observe(uint32[] calldata) external view returns (int56[] memory, uint160[] memory);
}

/// @notice Positive score: 10001 minus relative price disagreement in bps, capped at 10000. Pair with QUORUM.
/// @dev Both feeds must represent the same asset/quote pair. A fixed oracle can be a reviewed constant-price feed.
contract PriceDeviationReader is RiskReader {
    IAggregatorV3 public immutable MARKET_FEED;
    IAggregatorV3 public immutable REFERENCE_FEED;
    uint32 public immutable MARKET_HEARTBEAT;
    uint32 public immutable REFERENCE_HEARTBEAT;

    constructor(address marketFeed, address referenceFeed, uint32 marketHeartbeat, uint32 referenceHeartbeat) {
        if (
            marketFeed.code.length == 0 || referenceFeed.code.length == 0 || marketHeartbeat == 0
                || referenceHeartbeat == 0 || marketHeartbeat > 2 days || referenceHeartbeat > 2 days
        ) revert BadConfiguration();
        MARKET_FEED = IAggregatorV3(marketFeed);
        REFERENCE_FEED = IAggregatorV3(referenceFeed);
        MARKET_HEARTBEAT = marketHeartbeat;
        REFERENCE_HEARTBEAT = referenceHeartbeat;
    }

    function _price(IAggregatorV3 feed, uint32 heartbeat) internal view returns (uint256) {
        (uint80 round, int256 answer,, uint256 updated, uint80 answered) = feed.latestRoundData();
        uint8 decimals = feed.decimals();
        if (
            answer <= 0 || updated == 0 || updated > block.timestamp || block.timestamp - updated > heartbeat
                || answered < round || decimals > 18
        ) revert InvalidReading();
        return uint256(answer) * 10 ** (18 - decimals);
    }

    function _score(uint256 market, uint256 benchmark) internal pure returns (uint256) {
        if (benchmark < 10000 || market < 10000) revert InvalidReading();
        uint256 delta = market > benchmark ? market - benchmark : benchmark - market;
        if (delta >= benchmark) return 1;
        return 10001 - FullMath.mulDiv(delta, 10000, benchmark);
    }

    function value() public view virtual override returns (uint256) {
        return _score(_price(MARKET_FEED, MARKET_HEARTBEAT), _price(REFERENCE_FEED, REFERENCE_HEARTBEAT));
    }
}

/// @notice Uniswap v3 geometric TWAP versus two independently configured USD feeds. Soft: require watcher quorum.
/// @dev Token/feed correspondence is deployment-reviewed; neither contract labels nor feed names prove it.
contract V3TwapDeviationReader is PriceDeviationReader {
    IObservedPool public immutable POOL;
    uint32 public immutable WINDOW;
    uint8 public immutable TOKEN0_DECIMALS;
    uint8 public immutable TOKEN1_DECIMALS;
    uint256 constant Q128 = 1 << 128;

    constructor(
        address pool,
        uint32 window,
        address token0UsdFeed,
        address token1UsdFeed,
        uint32 heartbeat0,
        uint32 heartbeat1
    ) PriceDeviationReader(token0UsdFeed, token1UsdFeed, heartbeat0, heartbeat1) {
        if (pool.code.length == 0 || window < 60 || window > 1 days) revert BadConfiguration();
        uint8 d0 = IERC20(IObservedPool(pool).token0()).decimals();
        uint8 d1 = IERC20(IObservedPool(pool).token1()).decimals();
        if (d0 > 18 || d1 > 18) revert BadConfiguration();
        POOL = IObservedPool(pool);
        WINDOW = window;
        TOKEN0_DECIMALS = d0;
        TOKEN1_DECIMALS = d1;
    }

    /// @dev Binary fixed-point exponentiation of 1.0001^tick; no external math dependency. Floor arithmetic.
    function ratioAtTick(int24 tick) public pure returns (uint256) {
        if (tick < -887272 || tick > 887272) revert InvalidReading();
        uint256 n = uint256(tick < 0 ? -int256(tick) : int256(tick));
        uint256 base = Q128 + Q128 / 10000;
        uint256 p = Q128;
        while (n > 0) {
            if (n & 1 == 1) p = FullMath.mulDiv(p, base, Q128);
            n >>= 1;
            if (n > 0) base = FullMath.mulDiv(base, base, Q128);
        }
        return tick < 0 ? FullMath.mulDiv(Q128, Q128, p) : p;
    }

    function value() public view override returns (uint256) {
        uint32[] memory secondsAgo = new uint32[](2);
        secondsAgo[0] = WINDOW;
        (int56[] memory ticks,) = POOL.observe(secondsAgo);
        if (ticks.length != 2) revert InvalidReading();
        int56 delta;
        unchecked {
            delta = ticks[1] - ticks[0];
        }
        int56 window = int56(uint56(WINDOW));
        int56 average = delta / window;
        if (delta < 0 && delta % window != 0) average--;
        if (average < -887272 || average > 887272) revert InvalidReading();
        uint256 dex = FullMath.mulDiv(
            ratioAtTick(int24(average)), 10 ** (uint256(TOKEN0_DECIMALS) + 18), Q128 * 10 ** uint256(TOKEN1_DECIMALS)
        );
        uint256 benchmark =
            FullMath.mulDiv(_price(MARKET_FEED, MARKET_HEARTBEAT), 1e18, _price(REFERENCE_FEED, REFERENCE_HEARTBEAT));
        return _score(dex, benchmark);
    }
}
