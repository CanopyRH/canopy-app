// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitRouter} from "../src/ExitRouter.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {IERC20, IERC4626} from "../src/interfaces/IExternal.sol";

interface ForkVm {
    function prank(address) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function warp(uint256) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
}

interface IVaultV2Admin {
    function abdicated(bytes4) external view returns (bool);
    function setSendSharesGate(address) external;
    function setReceiveSharesGate(address) external;
    function setReceiveAssetsGate(address) external;
}

/// @notice Runs only on a Base fork: forge test --match-contract BaseForkTest --fork-url <rpc>
contract BaseForkTest {
    ForkVm internal constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    IERC20 internal constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant SWAP = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant USDC_FEED = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
    address internal constant ETH_FEED = 0xa4250cE1aA15Ff4cb5E5a8655293b65694e436Ed;
    address internal constant KEEPER = address(0xB0B);
    uint256 internal constant PK_A = 0xA1;
    uint256 internal constant PK_B = 0xB2;

    struct Case {
        string name;
        address vault;
        address holder;
    }
}
