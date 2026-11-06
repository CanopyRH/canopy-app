// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, IERC4626} from "../interfaces/IExternal.sol";
import {IExitAdapter} from "../interfaces/IExitAdapter.sol";
import {SafeTransferLib} from "../lib/SafeTransferLib.sol";
import {AdapterBase} from "./AdapterBase.sol";

/// @title ERC4626Adapter
/// @notice Exits ERC-4626 vault shares (Morpho Vault V2 / MetaMorpho and others).
/// @dev Morpho Vault V2 returns 0 from maxRedeem, so the adapter first tries the requested amount and
/// only falls back to maxRedeem when the vault reports a non-zero figure. Keepers pick a redeemable
/// amount off-chain by simulation. Whatever is not redeemed returns to the router, then the owner.
contract ERC4626Adapter is IExitAdapter, AdapterBase {
    using SafeTransferLib for address;

    /// @param router The ExitRouter this adapter acts for.
    constructor(address router) AdapterBase(router) {}

    /// @notice The router pulls the vault's own shares.
    /// @param target The vault.
    /// @return asset The vault (its share token).
    /// @return isNft Always false.
    function positionAsset(address target) external pure returns (address asset, bool isNft) {
        return (target, false);
    }

    /// @notice The vault's underlying asset is the only output.
    /// @param target The vault.
    /// @return tokens The vault's asset.
    function outputs(address target, uint256) external view returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = IERC4626(target).asset();
    }

    /// @notice Redeem `shares` held by this adapter to the router, and send back any shares left unredeemed. Router only.
    /// @param target The vault.
    /// @param shares The shares the router moved here.
    function unwind(address target, uint256 shares) external onlyRouter {
        bool done;
        try IERC4626(target).redeem(shares, ROUTER, address(this)) {
            done = true;
        } catch {}
        if (!done) {
            uint256 m;
            try IERC4626(target).maxRedeem(address(this)) returns (uint256 x) {
                m = x;
            } catch {}
            if (m > 0 && m < shares) {
                try IERC4626(target).redeem(m, ROUTER, address(this)) {} catch {}
            }
        }
        uint256 left = IERC20(target).balanceOf(address(this));
        if (left > 0) target.safeTransfer(ROUTER, left);
    }
}
