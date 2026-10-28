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

    function canReceiveAssets(address a) external view returns (bool) {
        return refused != address(0) && a != refused;
    }
}

/// @notice Runs only on a Base fork: forge test --match-contract BaseForkV2Test --fork-url <rpc>
/// Live state, not pinned to a block. Figures in comments were read at Base block 53401195.
contract BaseForkV2Test {
    ForkVm internal constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    IERC20 internal constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IMorpho internal constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    IMulticall3 internal constant MC = IMulticall3(0xcA11bde05977b3631167028862bE2a173976CA11);
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant SWAP = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant USDC_FEED = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
    address internal constant KEEPER = address(0xB0B);
    uint256 internal constant PK_A = 0xA1;
    uint256 internal constant PK_B = 0xB2;
    uint256 internal constant MIN_MOVE = 1_000e6; // same floor as keeper/liquidity.ts

    /// RockawayX Midas USDC Prime: penalty 0, three markets, about $600K. Its liquidity market holds only about
    /// $214K of the vault, so its largest holder ($578K) is bigger than anything a plain redeem can reach.
    address internal constant ZERO_PENALTY_VAULT = 0xAE4181CFB5aaA08bbE77d269c6B595672b9F9Edc;
    address internal constant ZERO_PENALTY_HOLDER = 0xcBA0831826827c1B2DCc66aB1e24F4C7e7808C36;

    /// OUSD Vault V2: a real allowlist on receive-shares, set and abdicated. Nothing about it is simulated.
    address internal constant GATED_VAULT = 0x2Ba14b2e1E7D2189D3550b708DFCA01f899f33c1;
    address internal constant GATED_HOLDER = 0xB1d624fc40824683e2bFBEfd19eB208DbBE00866;

    /// Steakhouse Prime USDC, a small V2 feeding the V1 vault: gates unset, not abdicated, setter timelocks of 0.
    address internal constant OPEN_VAULT = 0x3deDcEcF0246474246a8C5e89dEa35170023071D;
    address internal constant OPEN_HOLDER = 0xC346125e8fA266253B27eD95235B01B65071C2e8;

    /// Every V2 vault in web/src/config.ts. Steakhouse USDC V2 and a real holder of it come first.
    address[7] internal launchV2 = [
        0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9,
        0x050cE30b927Da55177A4914EC73480238BAD56f0,
        0xbeeff7aE5E00Aae3Db302e4B0d8C883810a58100,
        0xbeef0786756810478b88982DE00F3CD7fdB8e7c7,
        0xbeeff2490FEffa212faC2f6553682C219E6a8845,
        0xBeEfF0be997Cca5B1c13A7433c2004637975739e,
        0x91C056B6d4311a743614FBc03ac32d4E6A2d3a3c
    ];
    address internal constant LAUNCH_HOLDER = 0xF63F5FCC54f5fd11f3c098053F330E032E4D9259;
}
