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
        address[] memory ws = new address[](2);
        ws[0] = vm.addr(PK_A);
        ws[1] = vm.addr(PK_B);
        book = new AlarmBook(address(this), ws);
        router = new ExitRouter(
            address(USDC), WETH, SWAP, address(book), address(this), address(this), USDC_FEED, 90_000,
            block.timestamp + 365 days, new address[](0)
        );
        adapter = new ERC4626Adapter(address(router));
        router.setAdapter(address(adapter), true);
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

    function _arm(address v, address h, uint8 harbour, uint16 slip) internal returns (bytes32 id) {
        ExitRouter.SwapLeg[] memory legs = new ExitRouter.SwapLeg[](harbour == 1 ? 1 : 0);
        if (harbour == 1) {
            legs[0] = ExitRouter.SwapLeg({
                token: WETH, feed: ETH_FEED, heartbeat: 3600, tokenDecimals: 18, path: abi.encodePacked(WETH, uint24(500), address(USDC))
            });
        }
        vm.prank(h);
        IERC20(v).approve(address(router), type(uint256).max);
        vm.prank(h);
        id = router.arm(
            ExitRouter.ArmParams({
                adapter: address(adapter),
                target: v,
                tokenId: 0,
                harbour: harbour,
                maxSlipBps: slip,
                termsHash: keccak256("terms-v1"),
                keys: _keys(),
                swaps: legs
            })
        );
    }

    function _fire() internal {
        bytes32 ev = keccak256("evidence");
        uint64 dl = uint64(block.timestamp + 600);
        bytes32 d = book.attestDigest(key, ev, dl);
        (uint256 lo, uint256 hi) = vm.addr(PK_A) < vm.addr(PK_B) ? (PK_A, PK_B) : (PK_B, PK_A);
        address[] memory s = new address[](2);
        bytes[] memory g = new bytes[](2);
        s[0] = vm.addr(lo);
        s[1] = vm.addr(hi);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(lo, d);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(hi, d);
        g[0] = abi.encodePacked(r1, s1, v1);
        g[1] = abi.encodePacked(r2, s2, v2);
        book.fireByQuorum(key, ev, dl, s, g);
    }

    function test_base_realHolderKeeperExits_everyVault() public {
        if (block.chainid != 8453) return;
        _fire();
        uint256 ran;
        for (uint256 i; i < cases.length; ++i) {
            Case memory c = cases[i];
            uint256 shares = IERC20(c.vault).balanceOf(c.holder);
            if (shares == 0) continue; // A real holder can leave. The other vaults still prove the path.
            ++ran;
            uint256 expected = IERC4626(c.vault).convertToAssets(shares);
            bytes32 id = _arm(c.vault, c.holder, 0, 0);
            uint256 before = USDC.balanceOf(c.holder);
            uint256 keeperBefore = USDC.balanceOf(KEEPER);
            vm.prank(KEEPER);
            router.exit(id, key, 0);
            uint256 got = USDC.balanceOf(c.holder) - before;
            require(got + 2 >= expected && got <= expected + 2, string.concat("fair value ", c.name));
            require(IERC20(c.vault).balanceOf(c.holder) == 0, string.concat("shares left ", c.name));
            require(USDC.balanceOf(address(router)) == 0, "router residue");
            require(USDC.balanceOf(KEEPER) == keeperBefore, "keeper paid");
            require(IERC20(c.vault).balanceOf(address(adapter)) == 0, "adapter residue");
            emit log_named_uint(c.name, got / 1e6);
        }
        require(ran * 2 > cases.length, "too few holders left, so refresh the list");
    }

    /// @dev A $300M+ V1 holder cannot fully exit, so the adapter's maxRedeem fallback runs on a live vault.
    function test_base_v1FallbackRedeemsWhatIsLiquid() public {
        if (block.chainid != 8453) return;
        address v = 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61;
        address h = address(bytes20(hex"93904eec579e5bf7a57c2dd4afbea0f1c3e6a1d1"));
        uint256 shares = IERC20(v).balanceOf(h);
        uint256 maxS = IERC4626(v).maxRedeem(h);
        emit log_named_uint("position USDC", IERC4626(v).convertToAssets(shares) / 1e6);
        emit log_named_uint("maxRedeem USDC", IERC4626(v).convertToAssets(maxS) / 1e6);
        bytes32 id = _arm(v, h, 0, 0);
        _fire();
        uint256 before = USDC.balanceOf(h);
        vm.prank(KEEPER);
        router.exit(id, key, 0);
        uint256 got = USDC.balanceOf(h) - before;
        uint256 left = IERC20(v).balanceOf(h);
        emit log_named_uint("redeemed USDC", got / 1e6);
        emit log_named_uint("shares left, USDC value", IERC4626(v).convertToAssets(left) / 1e6);
        require(got > 0, "something came out");
        require(USDC.balanceOf(address(router)) == 0, "router residue");
        require(IERC20(v).balanceOf(address(router)) == 0, "router holds no shares");
        require(IERC20(v).balanceOf(address(adapter)) == 0, "adapter holds no shares");
    }

    /// @dev Gates that were abdicated can never be set, so they cannot block an exit on these vaults.
    function test_base_largestV2VaultsAbdicatedGates() public view {
        if (block.chainid != 8453) return;
        address[4] memory v = [
            0xbeef0786756810478b88982DE00F3CD7fdB8e7c7,
            0xbeeff2490FEffa212faC2f6553682C219E6a8845,
            0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9,
            0x050cE30b927Da55177A4914EC73480238BAD56f0
        ];
        for (uint256 i; i < v.length; ++i) {
            IVaultV2Admin g = IVaultV2Admin(v[i]);
            require(g.abdicated(IVaultV2Admin.setSendSharesGate.selector), "send abdicated");
            require(g.abdicated(IVaultV2Admin.setReceiveSharesGate.selector), "receive abdicated");
            require(g.abdicated(IVaultV2Admin.setReceiveAssetsGate.selector), "assets abdicated");
        }
    }

    /// @dev Real Uniswap pool and real feed: exits a WETH vault into USDC.
    function test_base_swapOnRealPool() public {
        if (block.chainid != 8453) return;
        address v = address(bytes20(hex"a0e430870c4604ccfc7b38ca7845b1ff653d0ff1"));
        address h = address(bytes20(hex"a9911182421b6bad13d188914d602f7924de840e"));
        uint256 shares = IERC20(v).balanceOf(h);
        uint256 wethOut = IERC4626(v).convertToAssets(shares);
        (bool ok, uint256 minOut) = router.quoteMinOut(ETH_FEED, 3600, 18, wethOut, 100);
        require(ok, "quote ok");
        bytes32 id = _arm(v, h, 1, 1000);
        _fire();
        uint256 before = USDC.balanceOf(h);
        uint256 wBefore = IERC20(WETH).balanceOf(h);
        vm.prank(KEEPER);
        router.exit(id, key, 0);
        uint256 got = USDC.balanceOf(h) - before;
        uint256 raw = IERC20(WETH).balanceOf(h) - wBefore;
        emit log_named_uint("WETH milli out", wethOut / 1e15);
        emit log_named_uint("USDC received", got / 1e6);
        emit log_named_uint("raw WETH milli received", raw / 1e15);
        emit log_named_uint("oracle floor at 1%", minOut / 1e6);
        // A position this size (~$350K) sits near the pool's 1% depth, so which branch runs depends on the block.
        // Either the swap clears the floor, or it is skipped and the owner gets the WETH itself. Never anything less.
        if (got > 0) {
            require(got >= minOut, "a swap fills at or above the 1% floor");
            require(raw == 0, "no raw WETH after a swap");
        } else {
            require(raw * 1000 >= wethOut * 999, "a skipped swap delivers the WETH raw");
        }
        require(USDC.balanceOf(address(router)) == 0 && IERC20(WETH).balanceOf(address(router)) == 0, "no residue");
        require(IERC20(WETH).allowance(address(router), SWAP) == 0, "approval cleared");
    }
}
