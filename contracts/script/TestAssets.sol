// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Testnet only. Anyone can mint. Never deploy to mainnet.
contract TestUSD {
    string public constant name = "Canopy Test USD";
    string public constant symbol = "tUSD";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Testnet only. The real Timelock's flow, kept so test runs exercise a short delay. Never deploy to mainnet.
contract TestTimelock {
    address public immutable PROPOSER;
    uint256 public immutable DELAY;

    mapping(bytes32 => uint256) public eta;

    constructor(address proposer, uint256 delay) {
        PROPOSER = proposer;
        DELAY = delay;
    }

    function idOf(address target, uint256 value, bytes calldata data, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(target, value, data, salt));
    }

    function schedule(address target, uint256 value, bytes calldata data, bytes32 salt) external returns (bytes32 id) {
        require(msg.sender == PROPOSER, "proposer");
        id = idOf(target, value, data, salt);
        require(eta[id] == 0, "scheduled");
        eta[id] = block.timestamp + DELAY;
    }

    function execute(address target, uint256 value, bytes calldata data, bytes32 salt)
        external
        payable
        returns (bytes memory ret)
    {
        require(msg.sender == PROPOSER, "proposer");
        bytes32 id = idOf(target, value, data, salt);
        uint256 t = eta[id];
        require(t != 0 && block.timestamp >= t, "not ready");
        delete eta[id];
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        require(ok, "call failed");
    }
}

/// @notice Testnet only. A plain 1:1 ERC-4626 vault with a pause switch, so a real alarm can fire on a live chain.
contract TestVault {
    string public constant name = "Canopy Test Vault";
    string public constant symbol = "tVAULT";
    uint8 public constant decimals = 6;
    TestUSD public immutable token;
    address public immutable owner;
    address public immutable curator;
    bool public paused;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(TestUSD token_) {
        token = token_;
        owner = msg.sender;
        curator = msg.sender;
    }

    function asset() external view returns (address) {
        return address(token);
    }

    function totalAssets() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function convertToAssets(uint256 shares) external pure returns (uint256) {
        return shares;
    }

    function maxRedeem(address who) external view returns (uint256) {
        return balanceOf[who];
    }

    function setPaused(bool p) external {
        require(msg.sender == owner, "owner");
        paused = p;
    }
}
