// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ExitRouter} from "../ExitRouter.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";

/// @notice Minimal ABI of ERC-7579's execution-time executor entry point (single/default mode = bytes32(0)).
interface ICanopyAccount {
    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory);
}

/// @notice Audit candidate: an ERC-7579 executor with only additive rearming and owner-account exit.
/// @dev Checks the live floor at EXECUTION, not ERC-4337 validation: earlier batch actions cannot make a stale
/// validation-time comparison remove newly added keys. No Smart Sessions validation-policy compatibility is claimed.
/// The agent must have no other account authority. Owners install/remove this executor and establish the first arm.
contract CanopyArmPolicy is ReentrancyGuard {
    ExitRouter public immutable ROUTER;

    struct Permission {
        address agent;
        uint64 until;
        bytes32 termsHash;
    }
    mapping(address => Permission) public permission;
    error Unauthorized();
    error InvalidConfiguration();
    error FloorViolation();
    error AlreadyInitialized();
    error NotInitialized();

    constructor(address router) {
        if (router.code.length == 0) revert InvalidConfiguration();
        ROUTER = ExitRouter(payable(router));
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 2;
    }

    function isInitialized(address account) external view returns (bool) {
        return permission[account].agent != address(0);
    }

    function onInstall(bytes calldata data) external nonReentrant {
        if (permission[msg.sender].agent != address(0)) revert AlreadyInitialized();
        (address agent, uint64 until, bytes32 terms) = abi.decode(data, (address, uint64, bytes32));
        if (
            msg.sender.code.length == 0 || agent == address(0) || agent == msg.sender || until <= block.timestamp
                || until > block.timestamp + 365 days || terms == bytes32(0)
        ) revert InvalidConfiguration();
        permission[msg.sender] = Permission(agent, until, terms);
    }

    function onUninstall(bytes calldata) external nonReentrant {
        if (permission[msg.sender].agent == address(0)) revert NotInitialized();
        delete permission[msg.sender];
    }

    function _authorized(address account) private view {
        Permission memory p = permission[account];
        if (p.agent != msg.sender || block.timestamp >= p.until) revert Unauthorized();
    }

    function tighten(address account, ExitRouter.ArmParams calldata a) external nonReentrant {
        _authorized(account);
        bytes32 id = ROUTER.positionId(account, a.adapter, a.target, a.tokenId);
        if (!ROUTER.isArmed(id) || a.termsHash != permission[account].termsHash) revert FloorViolation();
        (address owner,,,, uint8 harbour, uint16 slip,,,,,) = ROUTER.positions(id);
        if (owner != account || a.harbour != harbour || a.maxSlipBps > slip || a.keys.length > 8 || a.keys.length == 0)
        {
            revert FloorViolation();
        }
        bytes32[] memory old = ROUTER.keysOf(id);
        for (uint256 i; i < old.length; i++) {
            bool found = false;
            for (uint256 j; j < a.keys.length; j++) {
                if (a.keys[j] == old[i]) found = true;
            }
            if (!found) revert FloorViolation();
        }
        for (uint256 i; i < a.keys.length; i++) {
            for (uint256 j; j < i; j++) {
                if (a.keys[i] == a.keys[j]) revert FloorViolation();
            }
        }
        if (a.keys.length == old.length && a.maxSlipBps == slip) revert FloorViolation();
        if (keccak256(abi.encode(a.swaps)) != keccak256(abi.encode(ROUTER.swapsOf(id)))) revert FloorViolation();
        _execute(account, abi.encodeCall(ExitRouter.arm, (a)));
    }

    function exit(address account, bytes32 id) external nonReentrant {
        _authorized(account);
        (address owner,,,,,,,,,,) = ROUTER.positions(id);
        if (owner != account) revert FloorViolation();
        _execute(account, abi.encodeCall(ExitRouter.exit, (id, bytes32(0), 0)));
    }

    function _execute(address account, bytes memory data) private {
        ICanopyAccount(account).executeFromExecutor(bytes32(0), abi.encodePacked(address(ROUTER), uint256(0), data));
    }
}
