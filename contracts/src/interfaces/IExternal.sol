// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The ERC-20 calls Canopy makes.
interface IERC20 {
    /// @notice Balance of an account.
    /// @param account The account.
    /// @return The balance.
    function balanceOf(address account) external view returns (uint256);
    /// @notice Token decimals.
    /// @return The decimals.
    function decimals() external view returns (uint8);
    /// @notice Total supply.
    /// @return The supply.
    function totalSupply() external view returns (uint256);
    /// @notice Transfer from the caller.
    /// @param to The recipient.
    /// @param amount The amount.
    /// @return True on success (some tokens return nothing).
    function transfer(address to, uint256 amount) external returns (bool);
    /// @notice Transfer using an allowance.
    /// @param from The holder.
    /// @param to The recipient.
    /// @param amount The amount.
    /// @return True on success (some tokens return nothing).
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    /// @notice Set an allowance.
    /// @param spender The spender.
    /// @param amount The allowance.
    /// @return True on success (some tokens return nothing).
    function approve(address spender, uint256 amount) external returns (bool);
    /// @notice An allowance.
    /// @param owner The holder.
    /// @param spender The spender.
    /// @return The allowance.
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @notice The ERC-721 calls Canopy makes.
interface IERC721 {
    /// @notice Holder of a token id.
    /// @param id The token id.
    /// @return The holder.
    function ownerOf(uint256 id) external view returns (address);
    /// @notice Move a token id.
    /// @param from The holder.
    /// @param to The recipient.
    /// @param id The token id.
    function transferFrom(address from, address to, uint256 id) external;
}

/// @notice ERC-4626. Morpho Vault V2 returns 0 from max* views, so adapters never rely on them.
interface IERC4626 {
    /// @notice The underlying asset.
    /// @return The asset.
    function asset() external view returns (address);
    /// @notice Share decimals.
    /// @return The decimals.
    function decimals() external view returns (uint8);
    /// @notice Assets under management.
    /// @return The assets.
    function totalAssets() external view returns (uint256);
    /// @notice Assets a number of shares is worth.
    /// @param shares The shares.
    /// @return The assets.
    function convertToAssets(uint256 shares) external view returns (uint256);
    /// @notice Shares an owner can redeem now (Morpho Vault V2: always 0).
    /// @param owner The holder.
    /// @return The shares.
    function maxRedeem(address owner) external view returns (uint256);
    /// @notice Burn shares for assets.
    /// @param shares The shares to burn.
    /// @param receiver Who receives the assets.
    /// @param owner Whose shares are burned.
    /// @return assets The assets paid.
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

/// @notice Chainlink-style price feed.
interface IAggregatorV3 {
    /// @notice Answer decimals.
    /// @return The decimals.
    function decimals() external view returns (uint8);
    /// @notice The latest round.
    /// @return roundId The round.
    /// @return answer The price.
    /// @return startedAt When the round started.
    /// @return updatedAt When the answer was written.
    /// @return answeredInRound The round the answer came from.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Uniswap SwapRouter02 (IV3SwapRouter). No deadline field in SwapRouter02's structs.
interface IV3SwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /// @notice Swap an exact input along a multi-hop path.
    /// @param params The path, recipient, input and minimum output.
    /// @return amountOut The output.
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice WETH deposit.
interface IWETH {
    /// @notice Wrap the sent ETH.
    function deposit() external payable;
}
