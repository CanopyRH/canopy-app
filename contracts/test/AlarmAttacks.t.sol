// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {Timelock} from "../src/Timelock.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {MockERC20, MockVault, MockFeed} from "./Mocks.sol";

/// @dev ERC-4626 with real custody: totalAssets is the vault's token balance and deposits and redeems move real tokens.
contract RealVault is MockERC20 {
    MockERC20 public immutable assetToken;

    constructor(MockERC20 a) MockERC20(18) {
        assetToken = a;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function totalAssets() public view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    function convertToAssets(uint256 s) public view returns (uint256) {
        return totalSupply == 0 ? s : (s * totalAssets()) / totalSupply;
    }

    function maxRedeem(address o) external view returns (uint256) {
        return balanceOf[o];
    }

    function deposit(uint256 a, address to) external returns (uint256 s) {
        s = totalSupply == 0 ? a : (a * totalSupply) / totalAssets();
        assetToken.transferFrom(msg.sender, address(this), a);
        mint(to, s);
    }
}
