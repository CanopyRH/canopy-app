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

    function setTotalAssetsBacking(uint256 extra) external {
        assetToken.mint(address(this), extra);
    }

    function totalAssets() public view returns (uint256) {
        return (totalSupply * assetsPerShare) / 1e18;
    }

    function convertToAssets(uint256 s) public view returns (uint256) {
        return (s * assetsPerShare) / 1e18;
    }

    function maxRedeem(address o) external view returns (uint256) {
        if (zeroMax) return 0;
        uint256 byLiquid = (liquid * 1e18) / assetsPerShare;
        return byLiquid < balanceOf[o] ? byLiquid : balanceOf[o];
    }

    function deposit(address to, uint256 shares) external {
        uint256 a = convertToAssets(shares);
        assetToken.mint(address(this), a);
        liquid += a;
        mint(to, shares);
    }

    function redeem(uint256 s, address receiver, address owner) external returns (uint256 a) {
        require(msg.sender == owner, "owner");
        a = convertToAssets(s);
        require(a <= liquid, "insufficient liquidity");
        liquid -= a;
        _burn(owner, s);
        assetToken.transfer(receiver, a);
    }
}

contract MockFeed {
    int256 public answer;
    uint256 public updatedAt;

    constructor(int256 a) {
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 u) external {
        answer = a;
        updatedAt = u;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @dev Pays a fixed rate: `outPer1e18` stable units per 1e18 input tokens.
contract MockSwapRouter {
    MockERC20 public immutable stable;
    uint256 public outPer1e18;
    bool public broken;

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    constructor(MockERC20 s) {
        stable = s;
    }

    function setRate(uint256 r) external {
        outPer1e18 = r;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function exactInput(ExactInputParams calldata p) external payable returns (uint256 out) {
        require(!broken, "broken");
        address token = address(bytes20(p.path[0:20]));
        out = (p.amountIn * outPer1e18) / 1e18;
        require(out >= p.amountOutMinimum, "too little received");
        MockERC20(token).transferFrom(msg.sender, address(this), p.amountIn);
        stable.mint(p.recipient, out);
    }
}

contract MockPausable {
    bool public paused;

    function setPaused(bool p) external {
        paused = p;
    }
}

contract MockOwned {
    address public owner;
    address public curator;

    constructor(address o) {
        owner = o;
        curator = o;
    }

    function setCurator(address c) external {
        curator = c;
    }
}

/// @dev An allowlisted adapter that keeps whatever it receives.
contract EvilAdapter is IExitAdapter {
    function positionAsset(address target) external pure returns (address, bool) {
        return (target, false);
    }

    function outputs(address, uint256) external pure returns (address[] memory t) {
        t = new address[](0);
    }

    function unwind(address, uint256) external {}
}

/// @dev Unlisted malicious vault. During redeem it attacks the router, then lies about what it did.
contract EvilVault is MockERC20 {
    address public fakeAsset;
    address public router;
    bytes32 public victimPos;
    address public victim;
    address public owedToken;
    bool public attackHit;
    uint256 public reverts;
    uint256 public successes;

    constructor(address asset_, address router_) MockERC20(18) {
        fakeAsset = asset_;
        router = router_;
    }

    function setVictim(bytes32 p, address v, address t) external {
        victimPos = p;
        victim = v;
        owedToken = t;
    }

    function asset() external view returns (address) {
        return fakeAsset;
    }

    function maxRedeem(address) external pure returns (uint256) {
        return 0;
    }

    function convertToAssets(uint256 s) external pure returns (uint256) {
        return s;
    }

    function totalAssets() external view returns (uint256) {
        return totalSupply;
    }

    function redeem(uint256 s, address, address owner) external returns (uint256) {
        attackHit = true;
        _try(abi.encodeWithSignature("exit(bytes32,bytes32,uint256)", victimPos, bytes32(0), uint256(0)));
        _try(abi.encodeWithSignature("claimOwed(address,address)", victim, owedToken));
        _try(abi.encodeWithSignature("disarm(bytes32)", victimPos));
        _try(abi.encodeWithSignature("disarmAll()"));
        _burn(owner, s);
        return s;
    }

    function _try(bytes memory d) internal {
        (bool ok,) = router.call(d);
        if (ok) successes++;
        else reverts++;
    }
}

/// @dev Malicious vault whose redeem succeeds, so the outcome of each reentry attempt survives the exit.
contract ReentrantVault is MockERC20 {
    MockERC20 public immutable stableToken;
    address public immutable router;
    bytes32 public victimPos;
    bytes32 public liveKey;
    address public victim;
    bool public armedAttack;
    bool public exitEntered;
    bool public claimEntered;
    bytes4 public exitError;
    bytes4 public claimError;

    constructor(MockERC20 s, address r) MockERC20(18) {
        stableToken = s;
        router = r;
    }

    function setVictim(bytes32 p, bytes32 k, address v) external {
        victimPos = p;
        liveKey = k;
        victim = v;
        armedAttack = true;
    }

    function asset() external view returns (address) {
        return address(stableToken);
    }

    function maxRedeem(address) external pure returns (uint256) {
        return 0;
    }

    function convertToAssets(uint256 s) external pure returns (uint256) {
        return s;
    }

    function totalAssets() external view returns (uint256) {
        return totalSupply;
    }
}
