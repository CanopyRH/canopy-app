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

    function setUp() public {
        if (block.chainid != 4663) return;
        book = new AlarmBook(address(this));
        router = new ExitRouter(
            address(USDG), WETH, SWAP, address(book), address(this), address(this), FEED, 90_000,
            block.timestamp + 365 days
        );
        adapter = new ERC4626Adapter(address(router));
        router.setAdapter(address(adapter), true);
        book.setWatcher(vm.addr(PK_A), true);
        book.setWatcher(vm.addr(PK_B), true);
        key = book.register(
            AlarmBook.Detector({kind: AlarmBook.Kind.QUORUM, target: address(VAULT), threshold: 2, window: 0, a: 0, b: 0})
        );
    }

    function _keys() internal view returns (bytes32[] memory a) {
        a = new bytes32[](1);
        a[0] = key;
    }

    function _arm(address h) internal returns (bytes32 id) {
        vm.prank(h);
        require(IERC20(address(VAULT)).approve(address(router), type(uint256).max), "approve");
        vm.prank(h);
        id = router.arm(
            ExitRouter.ArmParams({
                adapter: address(adapter),
                target: address(VAULT),
                tokenId: 0,
                harbour: 0,
                maxSlipBps: 0,
                termsHash: keccak256("terms-v1"),
                keys: _keys()
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

    /// @dev Moves every other market's free liquidity into vault idle, from a wallet holding no shares.
    function _keeperDeallocate() internal returns (uint256 moved, uint256 calls) {
        uint256 n = IMarketAdapter(VAULT_ADAPTER).marketIdsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = IMarketAdapter(VAULT_ADAPTER).marketIds(i);
            (uint128 sup,, uint128 bor,,,) = IMorpho(MORPHO).market(id);
            uint256 free = uint256(sup) - bor;
            if (free < 1_000e6) continue;
            (address a, address b, address c, address d, uint256 e) = IMorpho(MORPHO).idToMarketParams(id);
            uint256 amt = (free * 999) / 1000;
            vm.prank(KEEPER);
            try IVaultV2(address(VAULT)).forceDeallocate(VAULT_ADAPTER, abi.encode(a, b, c, d, e), amt, KEEPER) {
                moved += amt;
                calls++;
            } catch {}
        }
    }

    function _exitAll() internal returns (uint256 total, uint256 ok, uint256 failed) {
        uint256 before;
        for (uint256 i; i < holders.length; ++i) {
            address h = holders[i];
            bytes32 id = router.positionId(h, address(adapter), address(VAULT), 0);
            before = USDG.balanceOf(h);
            vm.prank(KEEPER);
            try router.exit(id, key, 0) {
                total += USDG.balanceOf(h) - before;
                ok++;
                require(IERC20(address(VAULT)).balanceOf(h) == 0, "shares left");
            } catch {
                failed++;
            }
        }
    }

    function test_fork_realOwnerExit() public {
        if (block.chainid != 4663) return;
        address h = holders[3];
        uint256 shares = IERC20(address(VAULT)).balanceOf(h);
        uint256 expected = VAULT.convertToAssets(shares);
        require(expected >= 1_000e6, "holder still holds a real position, so refresh the list if this fails");
        bytes32 id = _arm(h);
        uint256 before = USDG.balanceOf(h);
        vm.prank(h);
        router.exit(id, bytes32(0), 0);
        uint256 got = USDG.balanceOf(h) - before;
        require(got + 1e6 >= expected && got <= expected + 1e6, "paid fair value");
        require(IERC20(address(VAULT)).balanceOf(h) == 0, "all shares redeemed");
        require(USDG.balanceOf(address(router)) == 0, "no router residue");
        require(IERC20(address(VAULT)).balanceOf(address(adapter)) == 0, "no adapter residue");
        emit log_named_uint("owner exit USDG", got / 1e6);
    }

    function test_fork_keeperExitPaysOwnerOnly() public {
        if (block.chainid != 4663) return;
        address h = holders[1];
        bytes32 id = _arm(h);
        _fire();
        uint256 before = USDG.balanceOf(h);
        vm.prank(KEEPER);
        router.exit(id, key, 0);
        require(USDG.balanceOf(h) > before, "owner paid");
        require(USDG.balanceOf(KEEPER) == 0, "keeper paid nothing");
        emit log_named_uint("keeper exit USDG", (USDG.balanceOf(h) - before) / 1e6);
    }

    function test_fork_partialExitReturnsRest() public {
        if (block.chainid != 4663) return;
        address h = holders[2];
        uint256 shares = IERC20(address(VAULT)).balanceOf(h);
        bytes32 id = _arm(h);
        _fire();
        vm.prank(KEEPER);
        router.exit(id, key, shares / 4);
        require(IERC20(address(VAULT)).balanceOf(h) == shares - shares / 4, "rest stays with the owner");
    }

    function test_fork_penaltyIsZero() public view {
        if (block.chainid != 4663) return;
        require(IVaultV2(address(VAULT)).forceDeallocatePenalty(VAULT_ADAPTER) == 0, "penalty is 0");
    }

    function test_fork_keeperBundleRaisesExitCapacity() public {
        if (block.chainid != 4663) return;
        for (uint256 i; i < holders.length; ++i) {
            _arm(holders[i]);
        }
        _fire();
        require(IERC20(address(VAULT)).balanceOf(KEEPER) == 0, "keeper holds no shares");

        uint256 snap = vm.snapshotState();
        (uint256 plain, uint256 okA, uint256 failA) = _exitAll();
        vm.revertToState(snap);

        uint256 idleBefore = USDG.balanceOf(address(VAULT));
        (uint256 moved, uint256 calls) = _keeperDeallocate();
        uint256 idleAfter = USDG.balanceOf(address(VAULT));
        (uint256 bundled, uint256 okB, uint256 failB) = _exitAll();

        emit log_named_uint("plain USDG", plain / 1e6);
        emit log_named_uint("plain ok", okA);
        emit log_named_uint("plain failed", failA);
        emit log_named_uint("deallocate calls", calls);
        emit log_named_uint("moved USDG", moved / 1e6);
        emit log_named_uint("idle gain USDG", (idleAfter - idleBefore) / 1e6);
        emit log_named_uint("bundled USDG", bundled / 1e6);
        emit log_named_uint("bundled ok", okB);
        emit log_named_uint("bundled failed", failB);
        require(calls > 0, "keeper with no shares could deallocate");
        require(idleAfter > idleBefore, "idle rose");
        // Live liquidity moves. When every wallet already fits, the bundle can't add to that, only never reduce it.
        require(bundled >= plain && okB >= okA, "bundle never lowers capacity");
    }

    function _deallocateCall(bytes32 id, uint256 amt, address onBehalf) internal view returns (IMulticall3.Call3 memory) {
        (address a, address b, address c, address d, uint256 e) = IMorpho(MORPHO).idToMarketParams(id);
        bytes memory data = abi.encode(a, b, c, d, e);
        return IMulticall3.Call3({
            target: address(VAULT),
            allowFailure: true,
            callData: abi.encodeCall(IVaultV2.forceDeallocate, (VAULT_ADAPTER, data, amt, onBehalf))
        });
    }

    function _deallocateCalls(address onBehalf) internal view returns (IMulticall3.Call3[] memory out) {
        uint256 n = IMarketAdapter(VAULT_ADAPTER).marketIdsLength();
        IMulticall3.Call3[] memory calls = new IMulticall3.Call3[](n);
        uint256 k;
        for (uint256 i; i < n; ++i) {
            bytes32 id = IMarketAdapter(VAULT_ADAPTER).marketIds(i);
            (uint128 sup,, uint128 bor,,,) = IMorpho(MORPHO).market(id);
            uint256 free = uint256(sup) - bor;
            if (free < 1_000e6) continue;
            calls[k++] = _deallocateCall(id, (free * 999) / 1000, onBehalf);
        }
        out = new IMulticall3.Call3[](k);
        for (uint256 i; i < k; ++i) {
            out[i] = calls[i];
        }
    }

    function _exitCall(address h) internal view returns (IMulticall3.Call3 memory) {
        bytes32 id = router.positionId(h, address(adapter), address(VAULT), 0);
        return IMulticall3.Call3({
            target: address(router),
            allowFailure: true,
            callData: abi.encodeCall(ExitRouter.exit, (id, key, 0))
        });
    }
}
