// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Contract-wallet signature check (ERC-1271).
interface IERC1271 {
    /// @notice Whether `signature` is valid for `hash`.
    /// @param hash The signed digest.
    /// @param signature The signature bytes.
    /// @return magicValue 0x1626ba7e if valid.
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue);
}
