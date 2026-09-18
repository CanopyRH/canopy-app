// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Timelock
/// @notice Minimal delay-enforcing admin. The proposer (multisig) schedules, waits DELAY, executes.
/// DELAY is set at deploy and can be 0, in which case one multisig batch schedules and executes together.
contract Timelock {
    uint256 public constant MAX_DELAY = 30 days;
    uint256 public constant GRACE = 14 days; // a scheduled change lapses, so it can't sit until nobody is looking

    address public immutable PROPOSER;
    uint256 public immutable DELAY;

    mapping(bytes32 => uint256) public eta;

    event Scheduled(bytes32 indexed id, address target, uint256 value, bytes data, bytes32 salt, uint256 eta);
    event Cancelled(bytes32 indexed id);
    event Executed(bytes32 indexed id);

    error NotProposer();
    error DelayTooLong();
    error AlreadyScheduled();
    error NotReady();
    error Lapsed();
    error CallFailed(bytes ret);

    constructor(address proposer, uint256 delay) {
        if (delay > MAX_DELAY) revert DelayTooLong();
        PROPOSER = proposer;
        DELAY = delay;
    }

    modifier onlyProposer() {
        if (msg.sender != PROPOSER) revert NotProposer();
        _;
    }

    function idOf(address target, uint256 value, bytes calldata data, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(target, value, data, salt));
    }

    function schedule(address target, uint256 value, bytes calldata data, bytes32 salt)
        external
        onlyProposer
        returns (bytes32 id)
    {
        id = idOf(target, value, data, salt);
        if (eta[id] != 0) revert AlreadyScheduled();
        eta[id] = block.timestamp + DELAY;
        emit Scheduled(id, target, value, data, salt, eta[id]);
    }

    function cancel(bytes32 id) external onlyProposer {
        delete eta[id];
        emit Cancelled(id);
    }

    function execute(address target, uint256 value, bytes calldata data, bytes32 salt)
        external
        payable
        onlyProposer
        returns (bytes memory ret)
    {
        bytes32 id = idOf(target, value, data, salt);
        uint256 t = eta[id];
        if (t == 0 || block.timestamp < t) revert NotReady();
        if (block.timestamp > t + GRACE) revert Lapsed();
        delete eta[id];
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit Executed(id);
    }

    receive() external payable {}
}
