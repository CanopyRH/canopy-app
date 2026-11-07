// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {IERC20, IERC4626} from "../interfaces/IExternal.sol";
import {IExitAdapter} from "../interfaces/IExitAdapter.sol";
import {AdapterBase} from "./AdapterBase.sol";
import {SafeTransferLib} from "../lib/SafeTransferLib.sol";
import {FullMath} from "../lib/FullMath.sol";

interface IForceVault {
    function isAdapter(address) external view returns (bool);
    function forceDeallocatePenalty(address) external view returns (uint256);
    function forceDeallocate(address, bytes calldata, uint256, address) external returns (uint256);
}

/// @notice Explicit opt-in: one vault, one reviewed deallocation path, immutable maximum penalty.
/// @dev Normal redemption is attempted first. A failed forced redemption reverts the whole penalty payment.
/// This does not create liquidity in an insolvent or fully borrowed market. Keeper must simulate the requested size.
contract MorphoV2ForceExitAdapter is IExitAdapter, AdapterBase {
    using SafeTransferLib for address;
    address public immutable VAULT;
    address public immutable ASSET;
    address public immutable LIQUIDITY_ADAPTER;
    uint16 public immutable MAX_PENALTY_BPS;
    bytes private _data;
    error InvalidPath();
    error PenaltyExceeded();
    error ExitUnavailable();

    constructor(address router, address vault, address adapter, bytes memory data, uint16 maxPenaltyBps)
        AdapterBase(router)
    {
        if (
            router == address(0) || vault.code.length == 0 || adapter.code.length == 0 || data.length > 2048
                || maxPenaltyBps > 200 || !IForceVault(vault).isAdapter(adapter)
        ) revert InvalidPath();
        address asset = IERC4626(vault).asset();
        if (asset.code.length == 0) revert InvalidPath();
        VAULT = vault;
        ASSET = asset;
        LIQUIDITY_ADAPTER = adapter;
        MAX_PENALTY_BPS = maxPenaltyBps;
        _data = data;
    }

    function deallocationData() external view returns (bytes memory) {
        return _data;
    }

    function positionAsset(address target) external view returns (address, bool) {
        if (target != VAULT) revert InvalidPath();
        return (VAULT, false);
    }

    function outputs(address target, uint256) external view returns (address[] memory out) {
        if (target != VAULT) revert InvalidPath();
        out = new address[](1);
        out[0] = ASSET;
    }

    function unwind(address target, uint256 shares) external onlyRouter {
        if (target != VAULT || shares == 0 || IERC20(VAULT).balanceOf(address(this)) < shares) revert InvalidPath();
        uint256 expected = IERC4626(VAULT).convertToAssets(shares);
        if (expected == 0) revert ExitUnavailable();
        uint256 beforeOutput = IERC20(ASSET).balanceOf(ROUTER);
        bool redeemed = false;
        try IERC4626(VAULT).redeem(shares, ROUTER, address(this)) {
            redeemed = true;
        } catch {}
        if (!redeemed) {
            if (!IForceVault(VAULT).isAdapter(LIQUIDITY_ADAPTER)) revert InvalidPath();
            uint256 penalty = IForceVault(VAULT).forceDeallocatePenalty(LIQUIDITY_ADAPTER);
            if (penalty > uint256(MAX_PENALTY_BPS) * 1e14) revert PenaltyExceeded();
            uint256 idle = IERC20(ASSET).balanceOf(VAULT);
            if (idle >= expected) revert ExitUnavailable(); // Gates or unsupported shares, not a liquidity problem.
            uint256 amount = FullMath.mulDiv(expected - idle, 1e18, 1e18 + penalty);
            if (amount == 0) revert ExitUnavailable();
            uint256 beforeShares = IERC20(VAULT).balanceOf(address(this));
            uint256 burned = IForceVault(VAULT).forceDeallocate(LIQUIDITY_ADAPTER, _data, amount, address(this));
            if (burned >= shares || IERC20(VAULT).balanceOf(address(this)) + burned != beforeShares) {
                revert PenaltyExceeded();
            }
            // Round the share-denominated cap down: rounding must not silently raise the user's maximum fee.
            if (burned > FullMath.mulDiv(shares, MAX_PENALTY_BPS, 10000)) revert PenaltyExceeded();
            IERC4626(VAULT).redeem(shares - burned, ROUTER, address(this));
        }
        uint256 paid = IERC20(ASSET).balanceOf(ROUTER) - beforeOutput;
        if (paid < FullMath.mulDiv(expected, 10000 - MAX_PENALTY_BPS, 10000) || paid == 0) revert ExitUnavailable();
        uint256 remaining = IERC20(VAULT).balanceOf(address(this));
        if (remaining > 0) VAULT.safeTransfer(ROUTER, remaining);
    }
}
