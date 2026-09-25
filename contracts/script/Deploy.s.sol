// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitRouter} from "../src/ExitRouter.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {Timelock} from "../src/Timelock.sol";
import {IAggregatorV3, IERC20} from "../src/interfaces/IExternal.sol";

interface DeployVm {
    function envAddress(string calldata) external view returns (address);
    function envUint(string calldata) external view returns (uint256);
    function envOr(string calldata, bool) external view returns (bool);
    function envOr(string calldata, uint256) external view returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Deploys Canopy v1. Refuses to run on unsafe settings. Admin setup then goes through the Timelock,
/// from multisig batches written by services/deploy/plan.ts. This script makes no admin calls.
/// TIMELOCK_DELAY defaults to 0, so admin changes take effect as soon as the multisig signs them.
contract Deploy {
    DeployVm internal constant vm = DeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bool public IS_SCRIPT = true;
    uint256 public constant BASE_MAINNET = 8453;
    uint256 public constant ROBINHOOD_MAINNET = 4663;
    uint256 public constant MIN_ADMIN_LIFE = 180 days;
    uint256 public constant MAX_ADMIN_LIFE = 730 days;

    struct Config {
        address stable;
        address weth;
        address swapRouter;
        address stableFeed;
        address proposer;
        address guardian;
        uint32 heartbeat;
        uint256 adminExpiry;
        uint256 timelockDelay;
        bool allowEoaAdmin;
    }

    struct Deployed {
        Timelock timelock;
        AlarmBook book;
        ExitRouter router;
        ERC4626Adapter adapter;
    }
}
