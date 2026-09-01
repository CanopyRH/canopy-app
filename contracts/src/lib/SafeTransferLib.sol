// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal SafeERC20-style helpers. Handles tokens that return nothing or a bool.
/// @dev `tryTransfer` never reverts and copies at most 32 bytes of return data, so a token
/// that reverts or returns a huge payload cannot block an in-kind exit.
library SafeTransferLib {
    error TransferFailed(address token);
    error TransferFromFailed(address token);
    error ApproveFailed(address token);

    function safeTransfer(address token, address to, uint256 amount) internal {
        if (!tryTransfer(token, to, amount)) revert TransferFailed(token);
    }

    function tryTransfer(address token, address to, uint256 amount) internal returns (bool success) {
        if (token.code.length == 0) return false;
        bytes memory data = abi.encodeWithSelector(0xa9059cbb, to, amount);
        assembly ("memory-safe") {
            let ok := call(gas(), token, 0, add(data, 0x20), mload(data), 0x00, 0x20)
            switch ok
            case 0 { success := 0 }
            default {
                switch returndatasize()
                case 0 { success := 1 }
                default { success := and(gt(returndatasize(), 0x1f), eq(mload(0x00), 1)) }
            }
        }
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        if (token.code.length == 0) revert TransferFromFailed(token);
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || !(ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))))) {
            revert TransferFromFailed(token);
        }
    }

    /// @dev Never reverts: used for the optional swap leg, which must never block an exit.
    function tryApprove(address token, address spender, uint256 amount) internal returns (bool) {
        if (token.code.length == 0) return false;
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }

    function allowance(address token, address owner, address spender) internal view returns (uint256 a) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0xdd62ed3e, owner, spender));
        if (!ok || ret.length < 32) return 0;
        a = abi.decode(ret, (uint256));
    }

    function balanceOf(address token, address account) internal view returns (uint256 bal) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!ok || ret.length < 32) return 0;
        bal = abi.decode(ret, (uint256));
    }
}
