// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A per-protocol exit adapter. Adapters are stateless and hold nothing between transactions.
interface IExitAdapter {
    /// @notice What the router pulls from the owner for a position on `target`.
    /// @param target The protocol target (vault).
    /// @return asset the token the router pulls from the owner
    /// @return isNft true for ERC-721 positions (tokenId identifies the position)
    function positionAsset(address target) external view returns (address asset, bool isNft);

    /// @notice Tokens the unwind can produce (address(0) = native ETH). Used for balance snapshots.
    /// @param target The protocol target.
    /// @param amountOrId The shares or NFT id being exited.
    /// @return tokens The possible outputs.
    function outputs(address target, uint256 amountOrId) external view returns (address[] memory tokens);

    /// @notice Unwind `amountOrId` already held by this adapter; send everything to msg.sender.
    /// @param target The protocol target.
    /// @param amountOrId The shares or NFT id the router moved to the adapter.
    function unwind(address target, uint256 amountOrId) external;
}
