// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IExitAdapter} from "../src/interfaces/IExitAdapter.sol";

contract MockERC20 {
    string public name = "Mock";
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    constructor(uint8 d) {
        decimals = d;
    }

    function mint(address to, uint256 a) public {
        balanceOf[to] += a;
        totalSupply += a;
    }

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) public virtual returns (bool) {
        _move(msg.sender, to, a);
        return true;
    }

    function transferFrom(address f, address t, uint256 a) public virtual returns (bool) {
        uint256 al = allowance[f][msg.sender];
        require(al >= a, "allowance");
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        _move(f, t, a);
        return true;
    }

    function _move(address f, address t, uint256 a) internal {
        require(!blocked[t], "blocked");
        require(balanceOf[f] >= a, "balance");
        balanceOf[f] -= a;
        balanceOf[t] += a;
    }

    function _burn(address f, uint256 a) internal {
        balanceOf[f] -= a;
        totalSupply -= a;
    }
}

/// @dev ERC-4626-shaped vault with a liquidity cap. Shares use 18 decimals.
contract MockVault is MockERC20 {
    MockERC20 public immutable assetToken;
    uint256 public assetsPerShare; // asset units per 1e18 shares
    uint256 public liquid;
    bool public zeroMax = true;
    bool public paused;

    constructor(MockERC20 a, uint256 pps) MockERC20(18) {
        assetToken = a;
        assetsPerShare = pps;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function setPrice(uint256 pps) external {
        assetsPerShare = pps;
    }

    function setLiquid(uint256 l) external {
        liquid = l;
    }

    function setZeroMax(bool z) external {
        zeroMax = z;
    }

    function setPaused(bool p) external {
        paused = p;
    }
}
