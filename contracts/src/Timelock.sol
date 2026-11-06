// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Timelock
/// @notice Minimal delay-enforcing admin. The proposer (multisig) schedules, waits DELAY, executes.
/// DELAY is set at deploy and can be 0, in which case one multisig batch schedules and executes together.
contract Timelock {
    /// @notice Longest delay the constructor accepts.
    uint256 public constant MAX_DELAY = 30 days;
    /// @notice A scheduled change lapses this long after it becomes ready, so it can't sit until nobody is looking.
    uint256 public constant GRACE = 14 days;

    /// @notice The only account that can schedule, cancel and execute.
    address public immutable PROPOSER;
    /// @notice The wait between scheduling and executing, set at deploy.
    uint256 public immutable DELAY;

    /// @notice When each scheduled change becomes ready (0 = not scheduled).
    mapping(bytes32 => uint256) public eta;

    /// @notice A change was scheduled.
    /// @param id The change's id.
    /// @param target The contract to call.
    /// @param value Native value to send.
    /// @param data The calldata.
    /// @param salt The salt.
    /// @param eta When it becomes ready.
    event Scheduled(bytes32 indexed id, address target, uint256 value, bytes data, bytes32 salt, uint256 eta);
    /// @notice A scheduled change was cancelled.
    /// @param id The change's id.
    event Cancelled(bytes32 indexed id);
    /// @notice A scheduled change ran.
    /// @param id The change's id.
    event Executed(bytes32 indexed id);

    /// @notice The caller is not PROPOSER.
    error NotProposer();
    /// @notice The delay is above MAX_DELAY.
    error DelayTooLong();
    /// @notice The same change (target, value, data, salt) is already scheduled.
    error AlreadyScheduled();
    /// @notice The change is not scheduled, or its delay has not passed.
    error NotReady();
    /// @notice The change became ready more than GRACE ago.
    error Lapsed();
    /// @notice The scheduled call reverted.
    /// @param ret The inner revert data.
    error CallFailed(bytes ret);

    /// @param proposer The multisig that runs the Timelock.
    /// @param delay The wait between scheduling and executing, at most MAX_DELAY.
    constructor(address proposer, uint256 delay) {
        if (delay > MAX_DELAY) revert DelayTooLong();
        PROPOSER = proposer;
        DELAY = delay;
    }

    modifier onlyProposer() {
        if (msg.sender != PROPOSER) revert NotProposer();
        _;
    }

    /// @notice The id of a change.
    /// @param target The contract to call.
    /// @param value Native value to send.
    /// @param data The calldata.
    /// @param salt Distinguishes otherwise identical changes.
    /// @return The id.
    function idOf(address target, uint256 value, bytes calldata data, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(target, value, data, salt));
    }

    /// @notice Schedule a change, ready after DELAY.
    /// @param target The contract to call.
    /// @param value Native value to send.
    /// @param data The calldata.
    /// @param salt Distinguishes otherwise identical changes.
    /// @return id The change's id.
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

    /// @notice Cancel a scheduled change.
    /// @param id The change's id.
    function cancel(bytes32 id) external onlyProposer {
        delete eta[id];
        emit Cancelled(id);
    }

    /// @notice Run a scheduled change that is ready and has not lapsed.
    /// @param target The contract to call.
    /// @param value Native value to send.
    /// @param data The calldata.
    /// @param salt The salt it was scheduled with.
    /// @return ret The call's return data.
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

    /// @notice Accepts native ETH for changes that send value.
    receive() external payable {}
}
