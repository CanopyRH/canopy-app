// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {IERC20} from "../interfaces/IExternal.sol";
import {SafeTransferLib} from "../lib/SafeTransferLib.sol";
import {SignatureChecker} from "../lib/SignatureChecker.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";

/// @notice Opt-in bond for an objectively provable fault: opposite signed decisions on the SAME snapshot.
/// @dev This does not judge prediction accuracy, missed alarms, delayed exits or LLM opinions.
/// Uses EOA signatures so later ERC-1271 revocation cannot erase evidence. AlarmBook approval is separate.
contract OperatorBond is ReentrancyGuard {
    using SafeTransferLib for address;
    address public immutable TOKEN;
    address public immutable TREASURY;
    bytes32 public immutable ROLE;
    uint256 public immutable MINIMUM;
    uint256 public immutable SLASH_AMOUNT;
    uint64 public constant EPOCH_SECONDS = 1 hours;
    uint64 public constant CHALLENGE_WINDOW = 7 days;
    uint64 public constant WITHDRAW_DELAY = 8 days;
    bytes32 public constant TYPEHASH = keccak256(
        "Statement(address signer,uint64 generation,bytes32 subject,uint64 epoch,bytes32 snapshot,bytes32 evidence,bool decision)"
    );
    bytes32 private immutable _domain;
    uint256 private immutable _chainId;

    struct Stake {
        uint256 amount;
        uint64 generation;
        uint64 startedAt;
        uint64 withdrawalAt;
    }

    struct Statement {
        address signer;
        uint64 generation;
        bytes32 subject;
        uint64 epoch;
        bytes32 snapshot;
        bytes32 evidence;
        bool decision;
    }
    mapping(address => Stake) public stakes;
    mapping(bytes32 => bool) public challenged;
    error InvalidBond();
    error InvalidProof();
    error TooEarly();
    event Deposited(address indexed operator, uint64 generation, uint256 amount);
    event WithdrawalRequested(address indexed operator, uint64 at);
    event Withdrawn(address indexed operator, uint256 amount);
    event Slashed(address indexed operator, bytes32 indexed fault, uint256 amount);

    constructor(address token, address treasury, bytes32 role, uint256 minimum, uint256 slashAmount) {
        if (
            token.code.length == 0 || treasury == address(0) || role == 0 || minimum == 0 || slashAmount == 0
                || slashAmount > minimum
        ) revert InvalidBond();
        TOKEN = token;
        TREASURY = treasury;
        ROLE = role;
        MINIMUM = minimum;
        SLASH_AMOUNT = slashAmount;
        _chainId = block.chainid;
        _domain = _domainFor(block.chainid);
    }

    function _domainFor(uint256 chain) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"
                ),
                keccak256("CanopyOperatorBond"),
                keccak256("1"),
                chain,
                address(this),
                ROLE
            )
        );
    }

    function digest(Statement calldata s) public view returns (bytes32) {
        bytes32 body =
            keccak256(
            abi.encode(TYPEHASH, s.signer, s.generation, s.subject, s.epoch, s.snapshot, s.evidence, s.decision)
        );
        return
            keccak256(
                abi.encodePacked("\x19\x01", block.chainid == _chainId ? _domain : _domainFor(block.chainid), body)
            );
    }

    function deposit(uint256 amount) external nonReentrant {
        Stake storage s = stakes[msg.sender];
        if (amount == 0 || s.withdrawalAt != 0) revert InvalidBond();
        if (s.amount == 0) {
            s.generation++;
            s.startedAt = uint64(block.timestamp);
        }
        uint256 beforeBalance = IERC20(TOKEN).balanceOf(address(this));
        TOKEN.safeTransferFrom(msg.sender, address(this), amount);
        // Fee-on-transfer and rebasing tokens are unsupported. Accounting must match tokens received.
        if (IERC20(TOKEN).balanceOf(address(this)) - beforeBalance != amount) revert InvalidBond();
        s.amount += amount;
        emit Deposited(msg.sender, s.generation, amount);
    }

    function eligible(address operator) external view returns (bool) {
        Stake storage s = stakes[operator];
        return s.amount >= MINIMUM && s.withdrawalAt == 0;
    }

    function requestWithdrawal() external nonReentrant {
        Stake storage s = stakes[msg.sender];
        if (s.amount == 0 || s.withdrawalAt != 0) revert InvalidBond();
        s.withdrawalAt = uint64(block.timestamp) + WITHDRAW_DELAY;
        emit WithdrawalRequested(msg.sender, s.withdrawalAt);
    }

    function withdraw() external nonReentrant {
        Stake storage s = stakes[msg.sender];
        if (s.withdrawalAt == 0 || block.timestamp < s.withdrawalAt) revert TooEarly();
        uint256 amount = s.amount;
        s.amount = 0;
        s.withdrawalAt = 0;
        TOKEN.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Permissionless proof submission. No reward for the submitter: no front-running bounty race.
    function challenge(Statement calldata a, bytes calldata sigA, Statement calldata b, bytes calldata sigB)
        external
        nonReentrant
    {
        Stake storage s = stakes[a.signer];
        uint256 epochStart = uint256(a.epoch) * EPOCH_SECONDS;
        uint256 epochEnd = epochStart + EPOCH_SECONDS;
        if (
            a.signer == address(0) || a.generation != s.generation || s.amount == 0 || a.subject == 0 || a.snapshot == 0
                || a.evidence == 0 || a.signer != b.signer || a.generation != b.generation || a.subject != b.subject
                || a.epoch != b.epoch || a.snapshot != b.snapshot || a.evidence != b.evidence
                || a.decision == b.decision || epochEnd <= s.startedAt || epochStart > block.timestamp
                || block.timestamp >= epochEnd + CHALLENGE_WINDOW
                || (s.withdrawalAt != 0 && epochStart >= s.withdrawalAt - WITHDRAW_DELAY)
        ) revert InvalidProof();
        bytes32 fault = keccak256(abi.encode(a.signer, a.generation, a.subject, a.epoch, a.snapshot, a.evidence));
        if (
            challenged[fault] || SignatureChecker.tryRecover(digest(a), sigA) != a.signer
                || SignatureChecker.tryRecover(digest(b), sigB) != a.signer
        ) revert InvalidProof();
        challenged[fault] = true;
        uint256 amount = s.amount < SLASH_AMOUNT ? s.amount : SLASH_AMOUNT;
        s.amount -= amount;
        TOKEN.safeTransfer(TREASURY, amount);
        emit Slashed(a.signer, fault, amount);
    }
}

contract WatcherBond is OperatorBond {
    constructor(address token, address treasury, uint256 minimum, uint256 slashAmount)
        OperatorBond(token, treasury, keccak256("CANOPY_WATCHER"), minimum, slashAmount)
    {}
}

contract KeeperBond is OperatorBond {
    constructor(address token, address treasury, uint256 minimum, uint256 slashAmount)
        OperatorBond(token, treasury, keccak256("CANOPY_KEEPER"), minimum, slashAmount)
    {}
}
