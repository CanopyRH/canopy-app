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

    Case[] internal cases;
    ExitRouter internal router;
    AlarmBook internal book;
    ERC4626Adapter internal adapter;
    bytes32 internal key;

    event log_named_uint(string key, uint256 val);
    event log_named_string(string key, string val);

    function setUp() public {
        if (block.chainid != 8453) return;
        book = new AlarmBook(address(this));
        router = new ExitRouter(
            address(USDC), WETH, SWAP, address(book), address(this), address(this), USDC_FEED, 90_000,
            block.timestamp + 365 days
        );
        adapter = new ERC4626Adapter(address(router));
        router.setAdapter(address(adapter), true);
        book.setWatcher(vm.addr(PK_A), true);
        book.setWatcher(vm.addr(PK_B), true);
        key = book.register(
            AlarmBook.Detector({kind: AlarmBook.Kind.QUORUM, target: address(0xBA5E), threshold: 2, window: 0, a: 0, b: 0})
        );
        cases.push(Case("sparkUSDC", address(bytes20(hex"7bfa7c4f149e7415b73bdedfe609237e29cbf34a")), address(bytes20(hex"d4b3f24f4c1020d34591118dc4290a78cc5bcc53"))));
        cases.push(Case("gtUSDCp", address(bytes20(hex"ee8f4ec5672f09119b96ab6fb59c27e1b7e44b61")), address(bytes20(hex"aa3e1a91fc83723e527062ff929a357354d10dcb"))));
        cases.push(Case("steakUSDC-v1", address(bytes20(hex"beefe94c8ad530842bfe7d8b397938ffc1cb83b2")), address(bytes20(hex"9b3d66c4ac6e282e45b51a07efea05eb90cf85b8"))));
        cases.push(Case("pUSDC", address(bytes20(hex"1401d1271c47648ac70cbcdfa3776d4a87ce006b")), address(bytes20(hex"e2ce3d95d2190923197433993f4b8ee574be4cfd"))));
        cases.push(Case("steakUSDC-v2", address(bytes20(hex"beef0e0834849acc03f0089f01f4f1eeb06873c9")), address(bytes20(hex"f63f5fcc54f5fd11f3c098053f330e032e4d9259"))));
        cases.push(Case("gtusdcp-v2", address(bytes20(hex"050ce30b927da55177a4914ec73480238bad56f0")), address(bytes20(hex"f0777e27c50eaa9a6cb2255b0aa3ee21e35aad84"))));
        cases.push(Case("bbqUSDC-v2", address(bytes20(hex"beeff7ae5e00aae3db302e4b0d8c883810a58100")), address(bytes20(hex"444a6579fe3bb8158fe2c73ad158336f7d6e03f6"))));
        cases.push(Case("grove-steakUSDC", address(bytes20(hex"beef0786756810478b88982de00f3cd7fdb8e7c7")), address(bytes20(hex"9dbb4c06357c3e9d92737d78f1a5d541b63ec7ee"))));
    }

    function _keys() internal view returns (bytes32[] memory a) {
        a = new bytes32[](1);
        a[0] = key;
    }
}
