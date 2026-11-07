// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, IERC4626, IAggregatorV3} from "../interfaces/IExternal.sol";
import {FullMath} from "../lib/FullMath.sol";

/// @notice Read-only adapters for AlarmBook.PRICE_BELOW. These contracts never move funds.
/// @dev Answers are positive: 1 is danger, 2 is clear for boolean readers. Failed reads revert (UNKNOWN).
abstract contract RiskReader {
    error BadConfiguration();
    error InvalidReading();

    function decimals() external pure returns (uint8) {
        return 0;
    }
    function value() public view virtual returns (uint256);

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 v = value();
        if (v == 0 || v > uint256(type(int256).max)) revert InvalidReading();
        // This is a current derived observation, not the underlying feed's timestamp.
        return (1, int256(v), block.timestamp, block.timestamp, 1);
    }
}

/// @notice Feed health, not price: arm below 2 to detect a stale, nonpositive or advisory-paused feed.
/// @dev A failing feed/pause read is UNKNOWN, never silently clear. Use to hold swaps or warn.
contract FeedHealthReader is RiskReader {
    IAggregatorV3 public immutable FEED;
    uint32 public immutable HEARTBEAT;
    address public immutable PAUSE_TARGET;
    bytes4 public immutable PAUSE_SELECTOR;

    constructor(address feed, uint32 heartbeat, address pauseTarget, bytes4 pauseSelector) {
        if (
            feed.code.length == 0 || heartbeat == 0 || heartbeat > 2 days
                || ((pauseTarget == address(0)) != (pauseSelector == bytes4(0)))
        ) revert BadConfiguration();
        FEED = IAggregatorV3(feed);
        HEARTBEAT = heartbeat;
        PAUSE_TARGET = pauseTarget;
        PAUSE_SELECTOR = pauseSelector;
    }

    function value() public view override returns (uint256) {
        (uint80 round, int256 answer,, uint256 updated, uint80 answered) = FEED.latestRoundData();
        if (updated > block.timestamp) revert InvalidReading();
        if (answer <= 0 || updated == 0 || answered < round || block.timestamp - updated > HEARTBEAT) return 1;
        if (PAUSE_TARGET != address(0)) {
            (bool ok, bytes memory result) = PAUSE_TARGET.staticcall(abi.encodeWithSelector(PAUSE_SELECTOR));
            if (!ok || result.length != 32) revert InvalidReading();
            uint256 paused = abi.decode(result, (uint256));
            if (paused > 1) revert InvalidReading();
            if (paused == 1) return 1;
        }
        return 2;
    }
}

/// @notice Redeemable shares as basis points of this owner's shares, plus one (to keep zero coverage readable).
/// @dev Morpho V2's unsupported maxRedeem view is explicitly excluded. No guarantee of execution liquidity.
contract VaultLiquidityReader is RiskReader {
    address public immutable VAULT;
    address public immutable OWNER;

    constructor(address vault, address owner) {
        if (vault.code.length == 0 || owner == address(0)) revert BadConfiguration();
        (bool v2, bytes memory result) = vault.staticcall(abi.encodeWithSignature("adaptersLength()"));
        if (v2 && result.length == 32) revert BadConfiguration();
        VAULT = vault;
        OWNER = owner;
    }

    function value() public view override returns (uint256) {
        uint256 shares = IERC20(VAULT).balanceOf(OWNER);
        if (shares == 0) return 10_001;
        uint256 liquid = IERC4626(VAULT).maxRedeem(OWNER);
        return liquid >= shares ? 10_001 : FullMath.mulDiv(liquid, 10_000, shares) + 1;
    }
}

/// @notice A pool's token reserve as basis points of an immutable owner-reviewed baseline, plus one.
/// @dev Trades, range shifts and legitimate withdrawals can reduce reserves. MUST pair with QUORUM in BOTH.
/// This is a reserve alarm, not a TWAP price oracle, creator-cluster detector or proof of a rug.
contract PoolReserveReader is RiskReader {
    IERC20 public immutable TOKEN;
    address public immutable POOL;
    uint256 public immutable BASELINE;

    constructor(address token, address pool, uint256 baseline) {
        if (token.code.length == 0 || pool.code.length == 0 || baseline == 0) revert BadConfiguration();
        TOKEN = IERC20(token);
        POOL = pool;
        BASELINE = baseline;
    }

    function value() public view override returns (uint256) {
        uint256 balance = TOKEN.balanceOf(POOL);
        return balance >= BASELINE ? 10_001 : FullMath.mulDiv(balance, 10_000, BASELINE) + 1;
    }
}

/// @notice Explicit, reviewed UTC trading intervals. Answer is seconds to close + 1, or 1 while closed.
/// @dev Holidays and daylight-saving changes must be supplied as real UTC intervals. Never guesses a calendar.
contract SessionReader is RiskReader {
    struct Window {
        uint64 open;
        uint64 close;
    }
    Window[] private _windows;
    uint64 public immutable VALID_FROM;
    uint64 public immutable VALID_UNTIL;

    constructor(Window[] memory windows, uint64 validFrom, uint64 validUntil) {
        if (windows.length == 0 || windows.length > 128 || validUntil <= validFrom) revert BadConfiguration();
        uint256 end = validFrom;
        for (uint256 i; i < windows.length; i++) {
            if (windows[i].open < end || windows[i].close <= windows[i].open || windows[i].close > validUntil) {
                revert BadConfiguration();
            }
            _windows.push(windows[i]);
            end = windows[i].close;
        }
        VALID_FROM = validFrom;
        VALID_UNTIL = validUntil;
    }

    function value() public view override returns (uint256) {
        if (block.timestamp < VALID_FROM || block.timestamp >= VALID_UNTIL) revert InvalidReading();
        for (uint256 i; i < _windows.length; i++) {
            Window memory w = _windows[i];
            if (block.timestamp < w.open) return 1;
            if (block.timestamp < w.close) return w.close - block.timestamp + 1;
        }
        return 1;
    }
}
