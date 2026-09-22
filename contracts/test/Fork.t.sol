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
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
}

interface IVaultV2 {
    function forceDeallocate(address adapter, bytes memory data, uint256 assets, address onBehalf) external returns (uint256);
    function forceDeallocatePenalty(address adapter) external view returns (uint256);
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

interface IDeposit {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
}

interface IMorpho {
    function market(bytes32) external view returns (uint128, uint128, uint128, uint128, uint128, uint128);
    function idToMarketParams(bytes32) external view returns (address, address, address, address, uint256);
}

/// @notice Runs only on a Robinhood Chain fork: forge test --match-contract ForkTest --fork-url <rpc>
contract ForkTest {
    ForkVm internal constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    IERC4626 internal constant VAULT = IERC4626(0xBeEff033F34C046626B8D0A041844C5d1A5409dd);
    IERC20 internal constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    address internal constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address internal constant VAULT_ADAPTER = 0x44ABc1d6cCFF2696d98890B92E2157AF242179c2;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant SWAP = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address internal constant FEED = 0x8bEeE3503F6860D5dac4cE26b5eEe92982951c2e;
    address internal constant KEEPER = address(0xB0B);

    address[8] internal holders = [
        0x822A52C3F0F105b4F7b2ef287dF038AA22838FF5,
        0xfFdA3d52e9FCAF40E610B59ddc7bAf2c1594Bd21,
        0x32Ba0BD09218b1b93681ecF83304A1E5566421f1,
        0x60822b4f00b75d47B847c67011fe13b8027624f0,
        0xf705f15F34be971Abc30e2a4c7C9EB18793bb10e,
        0xA4D23b86931F299459257131e35F4B17252Acec0,
        0x66A9d0C7966434704779c5C840cDc880B3523daA,
        0x4a73A2655b9E43238A85d1B0cA9EFe83a6Cd0d49
    ];

    ExitRouter internal router;
    AlarmBook internal book;
    ERC4626Adapter internal adapter;
    bytes32 internal key;
    uint256 internal constant PK_A = 0xA1;
    uint256 internal constant PK_B = 0xB2;
}
