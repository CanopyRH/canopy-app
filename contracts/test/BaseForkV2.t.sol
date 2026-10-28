// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitRouter} from "../src/ExitRouter.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {IERC20, IERC4626} from "../src/interfaces/IExternal.sol";
import {SafeTransferLib} from "../src/lib/SafeTransferLib.sol";

interface ForkVm {
    function prank(address) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function warp(uint256) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
}

interface IVaultV2 {
    function forceDeallocate(address adapter, bytes memory data, uint256 assets, address onBehalf) external returns (uint256);
    function forceDeallocatePenalty(address adapter) external view returns (uint256);
    function liquidityAdapter() external view returns (address);
    function liquidityData() external view returns (bytes memory);
    function curator() external view returns (address);
    function timelock(bytes4) external view returns (uint256);
    function abdicated(bytes4) external view returns (bool);
    function submit(bytes memory data) external;
    function sendSharesGate() external view returns (address);
    function receiveSharesGate() external view returns (address);
    function receiveAssetsGate() external view returns (address);
    function setSendSharesGate(address) external;
    function setReceiveSharesGate(address) external;
    function setReceiveAssetsGate(address) external;
    function canSendShares(address) external view returns (bool);
    function canReceiveShares(address) external view returns (bool);
    function canReceiveAssets(address) external view returns (bool);
}

interface IMarketAdapter {
    function marketIdsLength() external view returns (uint256);
    function marketIds(uint256) external view returns (bytes32);
}

interface IMulticall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory);
}

interface IMorpho {
    function market(bytes32) external view returns (uint128, uint128, uint128, uint128, uint128, uint128);
    function idToMarketParams(bytes32) external view returns (address, address, address, address, uint256);
    function position(bytes32, address) external view returns (uint256, uint128, uint128);
}

/// @notice The real allowlist gate behind OUSD Vault V2. Its setter name comes from selector 0x09ec923a.
interface IAllowlistGate {
    function owner() external view returns (address);
    function setIsWhitelisted(address, bool) external;
}

/// @notice SIMULATED GATE. No live vault runs this contract: it stands in for whatever a curator could point a
/// gate at. It refuses `refused`, or everyone when `refused` is zero.
contract RefusingGate {
    address internal immutable refused;

    constructor(address r) {
        refused = r;
    }

    function canSendShares(address a) external view returns (bool) {
        return refused != address(0) && a != refused;
    }

    function canReceiveShares(address a) external view returns (bool) {
        return refused != address(0) && a != refused;
    }
}
