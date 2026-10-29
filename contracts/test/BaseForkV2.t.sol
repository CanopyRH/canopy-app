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

    ExitRouter internal router;
    AlarmBook internal book;
    ERC4626Adapter internal adapter;
    bytes32 internal key;

    event log_named_uint(string key, uint256 val);

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
    }

    function _keys() internal view returns (bytes32[] memory a) {
        a = new bytes32[](1);
        a[0] = key;
    }

    function _arm(address v, address h) internal returns (bytes32 id) {
        vm.prank(h);
        IERC20(v).approve(address(router), type(uint256).max);
        vm.prank(h);
        id = router.arm(
            ExitRouter.ArmParams({
                adapter: address(adapter),
                target: v,
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

    /// @dev Market liquidity anyone could withdraw right now, ignoring who supplied it.
    function _free(bytes32 id) internal view returns (uint256) {
        (uint128 sup,, uint128 bor,,,) = MORPHO.market(id);
        return uint256(sup) - bor;
    }

    /// @dev What the vault's own adapter has supplied to a market.
    function _allocated(address la, bytes32 id) internal view returns (uint256) {
        (uint256 shares,,) = MORPHO.position(id, la);
        (uint128 sup, uint128 supShares,,,,) = MORPHO.market(id);
        return supShares == 0 ? 0 : (shares * sup) / supShares;
    }

    /// @dev The most the vault can take out of one market: its own allocation, capped by the free liquidity.
    function _reachable(address la, bytes32 id) internal view returns (uint256) {
        uint256 free = _free(id);
        uint256 alloc = _allocated(la, id);
        return free < alloc ? free : alloc;
    }

    function _deallocateData(bytes32 id) internal view returns (bytes memory) {
        (address a, address b, address c, address d, uint256 e) = MORPHO.idToMarketParams(id);
        return abi.encode(a, b, c, d, e);
    }

    /// @dev Calls in the shape keeper.ts sends: Multicall3 is the caller, the keeper wallet is `onBehalf`, failures
    /// allowed. `asKeeperSizes` uses the amount liquidity.ts computes today, free * 0.999.
    function _deallocateCalls(address v, bool asKeeperSizes) internal view returns (IMulticall3.Call3[] memory out) {
        address la = IVaultV2(v).liquidityAdapter();
        uint256 n = IMarketAdapter(la).marketIdsLength();
        IMulticall3.Call3[] memory calls = new IMulticall3.Call3[](n);
        uint256 k;
        for (uint256 i; i < n; ++i) {
            bytes32 id = IMarketAdapter(la).marketIds(i);
            uint256 size = asKeeperSizes ? _free(id) : _reachable(la, id);
            if (size < MIN_MOVE) continue;
            bytes memory call_ = abi.encodeCall(
                IVaultV2.forceDeallocate, (la, _deallocateData(id), (size * 999) / 1000, KEEPER)
            );
            calls[k++] = IMulticall3.Call3({target: v, allowFailure: true, callData: call_});
        }
        out = new IMulticall3.Call3[](k);
        for (uint256 i; i < k; ++i) {
            out[i] = calls[i];
        }
    }

    /// @dev One keeper exit, undone afterwards. Returns what the owner was paid, 0 if it reverted.
    function _trial(bytes32 id, address h, uint256 amount) internal returns (uint256 got) {
        uint256 snap = vm.snapshotState();
        uint256 before = USDC.balanceOf(h);
        vm.prank(KEEPER);
        try router.exit(id, key, amount) {
            got = USDC.balanceOf(h) - before;
        } catch {}
        vm.revertToState(snap);
    }

    /// @dev The keeper's sizeExit in keeper/simulate.ts: 100%, 50%, 25% and so on, up to 6 steps.
    function _keeperSizedExit(bytes32 id, address h, uint256 shares) internal returns (uint256 got) {
        uint256 amount = shares;
        for (uint256 i; i < 6 && got == 0; ++i) {
            got = _trial(id, h, amount);
            amount /= 2;
        }
    }

    /// @dev The fairest number for "without forceDeallocate": the largest exit that lands, found by bisection.
    function _largestPlainExit(bytes32 id, address h, uint256 shares) internal returns (uint256 best) {
        uint256 lo;
        uint256 hi = shares;
        for (uint256 i; i < 24; ++i) {
            uint256 mid = (lo + hi) / 2;
            uint256 got = _trial(id, h, mid);
            if (got > 0) {
                lo = mid;
                best = got;
            } else {
                hi = mid;
            }
        }
    }

    // ------------------------------------------------------------------ forceDeallocate

    /// @dev [forceDeallocate..., exit] as one Multicall3 transaction from the keeper. The exit must land.
    function _runBundle(address v, address h, bytes32 id) internal returns (uint256 got, uint256 calls, uint256 okCalls) {
        IMulticall3.Call3[] memory d = _deallocateCalls(v, false);
        IMulticall3.Call3[] memory all = new IMulticall3.Call3[](d.length + 1);
        for (uint256 i; i < d.length; ++i) {
            all[i] = d[i];
        }
        all[d.length] = IMulticall3.Call3({
            target: address(router),
            allowFailure: false,
            callData: abi.encodeCall(ExitRouter.exit, (id, key, 0))
        });
        uint256 before = USDC.balanceOf(h);
        uint256 keeperBefore = USDC.balanceOf(KEEPER);
        vm.prank(KEEPER);
        IMulticall3.Result[] memory res = MC.aggregate3(all);
        got = USDC.balanceOf(h) - before;
        calls = d.length;
        require(USDC.balanceOf(KEEPER) == keeperBefore && USDC.balanceOf(address(MC)) == 0, "keeper keeps nothing");
        for (uint256 i; i < d.length; ++i) {
            if (res[i].success) okCalls++;
        }
    }

    /// @dev A keeper with no shares runs [forceDeallocate..., exit] through Multicall3 on a live 0-penalty V2 vault.
    /// Nothing about the vault or its markets is altered. The holder is bigger than idle plus the liquidity market.
    function test_base_v2_keeperBundlePaysMoreThanPlainExit() public {
        if (block.chainid != 8453) return;
        address v = ZERO_PENALTY_VAULT;
        address h = ZERO_PENALTY_HOLDER;
        address la = IVaultV2(v).liquidityAdapter();
        require(IVaultV2(v).forceDeallocatePenalty(la) == 0, "penalty is 0");
        require(IERC20(v).balanceOf(KEEPER) == 0 && IERC20(v).balanceOf(address(MC)) == 0, "keeper holds no shares");

        uint256 shares = IERC20(v).balanceOf(h);
        uint256 expected = IERC4626(v).convertToAssets(shares);
        uint256 reach = USDC.balanceOf(v) + _reachable(la, keccak256(IVaultV2(v).liquidityData()));
        require(expected > reach, "holder is bigger than a plain redeem can reach");

        bytes32 id = _arm(v, h);
        _fire();

        uint256 fullNoHelp = _trial(id, h, 0);
        uint256 keeperSized = _keeperSizedExit(id, h, shares);
        uint256 largestPlain = _largestPlainExit(id, h, shares);
        require(fullNoHelp == 0, "a full exit reverts without the bundle");
        require(largestPlain > 0 && largestPlain <= reach + 1e6, "plain redeem stops at the liquidity market");

        (uint256 got, uint256 calls, uint256 okCalls) = _runBundle(v, h, id);

        emit log_named_uint("position USDC", expected / 1e6);
        emit log_named_uint("idle plus liquidity market USDC", reach / 1e6);
        emit log_named_uint("without, full exit USDC", fullNoHelp / 1e6);
        emit log_named_uint("without, keeper halving USDC", keeperSized / 1e6);
        emit log_named_uint("without, largest possible USDC", largestPlain / 1e6);
        emit log_named_uint("deallocate calls", calls);
        emit log_named_uint("deallocate calls ok", okCalls);
        emit log_named_uint("with bundle USDC", got / 1e6);

        require(okCalls == calls && calls > 1, "keeper with no shares could deallocate");
        require(got > largestPlain, "bundle paid the owner more");
        require(got + 1e6 >= expected && got <= expected + 1e6, "paid fair value");
        require(IERC20(v).balanceOf(h) == 0, "all shares redeemed");
        require(USDC.balanceOf(address(router)) == 0, "no router residue");
        require(IERC20(v).balanceOf(address(adapter)) == 0, "no adapter residue");
    }

    /// @dev Documents a keeper sizing bug, not a contract bug. liquidity.ts asks for free * 0.999 of each market, but
    /// on Base the vault is usually a small lender in a big market, so that is more than the vault has there. Every
    /// call reverts, allowFailure hides it, and the same vault and holder as above get no help from the bundle.
    function test_base_v2_keeperSizingByMarketFreeLiquidityMovesNothing() public {
        if (block.chainid != 8453) return;
        address v = ZERO_PENALTY_VAULT;
        IMulticall3.Call3[] memory d = _deallocateCalls(v, true);
        uint256 idleBefore = USDC.balanceOf(v);
        vm.prank(KEEPER);
        IMulticall3.Result[] memory res = MC.aggregate3(d);
        uint256 okD;
        for (uint256 i; i < res.length; ++i) {
            if (res[i].success) okD++;
        }
        emit log_named_uint("keeper-sized calls", d.length);
        emit log_named_uint("keeper-sized calls ok", okD);
        emit log_named_uint("idle moved USDC", (USDC.balanceOf(v) - idleBefore) / 1e6);
        require(d.length > 0, "liquidity.ts would send calls");
        require(okD == 0, "every call sized past the allocation reverts");
        require(USDC.balanceOf(v) == idleBefore, "nothing reached idle");
    }

    /// @dev No V2 vault in the web config can run the keeper bundle. Each charges a penalty, taken as a withdrawal of
    /// `onBehalf`'s shares, so a keeper with none underflows and reverts Panic(0x11). liquidity.ts skips these vaults
    /// anyway, because it only acts on a penalty of exactly 0.
    function test_base_v2_launchVaultsRefuseKeeperWithNoShares() public {
        if (block.chainid != 8453) return;
        bytes memory underflow = abi.encodeWithSignature("Panic(uint256)", uint256(0x11));
        for (uint256 i; i < launchV2.length; ++i) {
            IVaultV2 vault = IVaultV2(launchV2[i]);
            address la = vault.liquidityAdapter();
            uint256 penalty = vault.forceDeallocatePenalty(la);
            bytes32 liquidityId = keccak256(vault.liquidityData());
            (bytes32 best, uint256 bestReach, uint256 otherReach) = _otherMarkets(la, liquidityId);
            emit log_named_uint("vault index", i);
            emit log_named_uint("  totalAssets USDC", IERC4626(launchV2[i]).totalAssets() / 1e6);
            emit log_named_uint("  penalty, parts per 1e18", penalty);
            emit log_named_uint("  idle USDC", USDC.balanceOf(launchV2[i]) / 1e6);
            emit log_named_uint("  liquidity market reach USDC", _reachable(la, liquidityId) / 1e6);
            emit log_named_uint("  other markets reach USDC", otherReach / 1e6);
            require(penalty > 0, "launch vault penalty is not 0");
            if (bestReach < MIN_MOVE) (best, bestReach) = (liquidityId, _reachable(la, liquidityId)); // one-market vault
            bytes memory data = _deallocateData(best);
            vm.prank(KEEPER);
            try vault.forceDeallocate(la, data, bestReach / 2, KEEPER) {
                revert("keeper with no shares deallocated past a penalty");
            } catch (bytes memory e) {
                require(keccak256(e) == keccak256(underflow), "reverts on the share burn");
            }
        }
    }

    /// @dev The same call as above works once the keeper owns real shares, so the share burn is the only obstacle.
    /// The caller must be the holder of those shares: in the shape keeper.ts sends, Multicall3 is the caller and has
    /// no allowance from the keeper, so it still reverts. Dust comes from a real holder by transfer. Nothing about the
    /// vault's markets is altered.
    function test_base_v2_launchVaultPenaltyPaidFromKeeperShares() public {
        if (block.chainid != 8453) return;
        address v = launchV2[0];
        IVaultV2 vault = IVaultV2(v);
        address la = vault.liquidityAdapter();
        (bytes32 best, uint256 bestReach,) = _otherMarkets(la, keccak256(vault.liquidityData()));
        require(bestReach >= MIN_MOVE, "a market can be deallocated");
        uint256 amt = bestReach / 2;

        uint256 penaltyAssets = (amt * vault.forceDeallocatePenalty(la)) / 1e18 + 1;
        uint256 dust = (IERC20(v).balanceOf(LAUNCH_HOLDER) * (penaltyAssets * 2)) /
            IERC4626(v).convertToAssets(IERC20(v).balanceOf(LAUNCH_HOLDER));
        vm.prank(LAUNCH_HOLDER);
        IERC20(v).transfer(KEEPER, dust);

        uint256 idleBefore = USDC.balanceOf(v);
        bytes memory data = _deallocateData(best);
        IMulticall3.Call3[] memory viaMulticall = new IMulticall3.Call3[](1);
        viaMulticall[0] = IMulticall3.Call3({
            target: v,
            allowFailure: true,
            callData: abi.encodeCall(IVaultV2.forceDeallocate, (la, data, amt, KEEPER))
        });
        vm.prank(KEEPER);
        require(!MC.aggregate3(viaMulticall)[0].success, "Multicall3 cannot spend the keeper's shares");

        vm.prank(KEEPER);
        uint256 burned = vault.forceDeallocate(la, data, amt, KEEPER);
        emit log_named_uint("moved USDC", amt / 1e6);
        emit log_named_uint("penalty, USDC micro", penaltyAssets);
        emit log_named_uint("keeper shares burned", burned);
        require(burned > 0 && IERC20(v).balanceOf(KEEPER) == dust - burned, "penalty came from the keeper");
        require(USDC.balanceOf(v) == idleBefore + amt, "idle rose by the amount moved");
    }

    /// @dev Finds the market outside the liquidity market with the most reachable liquidity, and the total of them.
    function _otherMarkets(address la, bytes32 liquidityId) internal view returns (bytes32 best, uint256 bestReach, uint256 total) {
        uint256 n = IMarketAdapter(la).marketIdsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = IMarketAdapter(la).marketIds(i);
            if (id == liquidityId) continue;
            uint256 r = _reachable(la, id);
            total += r;
            if (r > bestReach) {
                best = id;
                bestReach = r;
            }
        }
    }

    // ------------------------------------------------------------------ share gates

    /// @dev Asserts a blocked exit: the expected revert, and nothing moved or changed for the owner.
    function _assertBlocked(address v, address h, bytes32 id, address caller, bytes32 k, bytes memory reason) internal {
        uint256 shares = IERC20(v).balanceOf(h);
        uint256 usdc = USDC.balanceOf(h);
        uint256 approved = IERC20(v).allowance(h, address(router));
        uint256 count = router.exitCount();
        vm.prank(caller);
        try router.exit(id, k, 0) {
            revert("exit went through a refusing gate");
        } catch (bytes memory e) {
            require(keccak256(e) == keccak256(reason), "reverted for the expected reason");
        }
        require(IERC20(v).balanceOf(h) == shares, "owner's shares untouched");
        require(USDC.balanceOf(h) == usdc, "owner's USDC untouched");
        require(IERC20(v).allowance(h, address(router)) == approved, "approval untouched");
        require(router.isArmed(id), "position stays armed");
        require(router.exitCount() == count, "no exit recorded");
        require(router.owed(h, v) == 0 && router.owed(h, address(USDC)) == 0, "nothing parked as owed");
        require(IERC20(v).balanceOf(address(router)) == 0 && USDC.balanceOf(address(router)) == 0, "no router residue");
        require(IERC20(v).balanceOf(address(adapter)) == 0 && USDC.balanceOf(address(adapter)) == 0, "no adapter residue");
    }

    /// @dev The owner calling the vault directly, without Canopy, undone afterwards. Returns 0 if it reverted.
    function _directRedeem(address v, address h, uint256 shares) internal returns (uint256 got) {
        uint256 snap = vm.snapshotState();
        vm.prank(h);
        try IERC4626(v).redeem(shares, h, h) returns (uint256 a) {
            got = a;
        } catch {}
        vm.revertToState(snap);
    }

    /// @dev The largest direct redeem that lands, found by bisection.
    function _largestDirectRedeem(address v, address h) internal returns (uint256 shares, uint256 assets) {
        uint256 hi = IERC20(v).balanceOf(h);
        for (uint256 i; i < 24; ++i) {
            uint256 mid = (shares + hi) / 2;
            uint256 got = _directRedeem(v, h, mid);
            if (got > 0) {
                shares = mid;
                assets = got;
            } else {
                hi = mid;
            }
        }
    }

    /// @dev The curator submits clearing the gate, waits out the timelock, and the setter still refuses.
    function _assertGateLockedOn(IVaultV2 vault, address gate) internal {
        uint256 snap = vm.snapshotState();
        bytes memory clear = abi.encodeCall(IVaultV2.setReceiveSharesGate, (address(0)));
        vm.prank(vault.curator());
        vault.submit(clear);
        vm.warp(block.timestamp + vault.timelock(IVaultV2.setReceiveSharesGate.selector));
        (bool cleared,) = address(vault).call(clear);
        require(!cleared && vault.receiveSharesGate() == gate, "abdication locks the gate on");
        vm.revertToState(snap);
    }

    /// @dev No simulation here. A live vault with a real gate that refuses our adapter, on a vault that abdicated
    /// the setter: arming succeeds, then every exit reverts at the first transfer. The owner can still redeem from the
    /// vault directly, up to what its V1 vault can pay, and the curator cannot clear the gate. Control at the end:
    /// the gate's own owner whitelists the adapter, nothing else changes, and the same size pays through the router.
    function test_base_v2_realGateSetAndAbdicatedBlocksExit() public {
        if (block.chainid != 8453) return;
        address v = GATED_VAULT;
        address h = GATED_HOLDER;
        IVaultV2 vault = IVaultV2(v);
        address gate = vault.receiveSharesGate();
        bytes memory transferFromFailed = abi.encodeWithSelector(SafeTransferLib.TransferFromFailed.selector, v);
        require(gate != address(0), "gate is set");
        require(vault.abdicated(IVaultV2.setReceiveSharesGate.selector), "and abdicated");
        require(vault.canReceiveShares(h), "gate lets the holder hold");
        require(!vault.canReceiveShares(address(adapter)), "gate refuses the adapter");

        bytes32 id = _arm(v, h);
        require(router.isArmed(id), "arming does not read gates");
        _fire();

        _assertBlocked(v, h, id, KEEPER, key, transferFromFailed);
        _assertBlocked(v, h, id, h, bytes32(0), transferFromFailed);

        (uint256 liquidShares, uint256 direct) = _largestDirectRedeem(v, h);
        require(direct > 0, "owner can still leave by calling the vault");

        _assertGateLockedOn(vault, gate);

        vm.prank(IAllowlistGate(gate).owner());
        IAllowlistGate(gate).setIsWhitelisted(address(adapter), true);
        uint256 got = _trial(id, h, liquidShares);
        emit log_named_uint("position USDC", IERC4626(v).convertToAssets(IERC20(v).balanceOf(h)) / 1e6);
        emit log_named_uint("router exit USDC", 0);
        emit log_named_uint("direct redeem, largest USDC", direct / 1e6);
        emit log_named_uint("router exit USDC, adapter whitelisted", got / 1e6);
        require(got + 1e6 >= direct, "the gate was the only obstacle");
    }

    /// @dev SIMULATED GATES on a real vault. OPEN_VAULT has no gate set today and has abdicated none of them. We
    /// impersonate its real curator and use the vault's own submit and setter, so there is no vm.etch and no storage
    /// write. The curator's action and the RefusingGate contract are the only simulated parts. Those setters have a
    /// timelock of 0 here, so the real curator could do this in one transaction, with no warning.
    function _gate(IVaultV2 vault, bytes memory setter) internal {
        vm.prank(vault.curator());
        vault.submit(setter);
        (bool ok,) = address(vault).call(setter);
        require(ok, "gate setter ran");
    }

    function _simulatedCase(
        string memory name,
        bytes memory setGate,
        bytes memory clearGate,
        bytes memory reason,
        bool directPays
    ) internal {
        address v = OPEN_VAULT;
        address h = OPEN_HOLDER;
        bytes32 id = router.positionId(h, address(adapter), v, 0);
        uint256 snap = vm.snapshotState();
        uint256 expected = IERC4626(v).convertToAssets(IERC20(v).balanceOf(h));

        _gate(IVaultV2(v), setGate);
        _assertBlocked(v, h, id, KEEPER, key, reason);
        uint256 direct = _directRedeem(v, h, IERC20(v).balanceOf(h));
        emit log_named_uint(string.concat(name, ", direct redeem USDC"), direct / 1e6);
        require(directPays ? direct + 1e6 >= expected : direct == 0, "direct redeem as expected");

        _gate(IVaultV2(v), clearGate);
        vm.prank(KEEPER);
        router.exit(id, key, 0);
        require(IERC20(v).balanceOf(h) == 0, "same position exits once the gate is gone");
        vm.revertToState(snap);
    }

    function test_base_v2_simulatedGatesBlockExitCleanly() public {
        if (block.chainid != 8453) return;
        address v = OPEN_VAULT;
        address h = OPEN_HOLDER;
        IVaultV2 vault = IVaultV2(v);
        require(!vault.abdicated(IVaultV2.setSendSharesGate.selector), "send gate not abdicated");
        require(!vault.abdicated(IVaultV2.setReceiveSharesGate.selector), "receive gate not abdicated");
        require(!vault.abdicated(IVaultV2.setReceiveAssetsGate.selector), "assets gate not abdicated");
        require(vault.sendSharesGate() == address(0) && vault.receiveSharesGate() == address(0), "no share gate today");
        require(vault.receiveAssetsGate() == address(0), "no assets gate today");

        uint256 expected = IERC4626(v).convertToAssets(IERC20(v).balanceOf(h));
        bytes32 id = _arm(v, h);
        _fire();
        uint256 control = _trial(id, h, 0);
        emit log_named_uint("position USDC", expected / 1e6);
        emit log_named_uint("no gate, exit USDC", control / 1e6);
        require(control + 1e6 >= expected, "with no gate the exit pays in full");

        address everyone = address(0);
        bytes memory fromFailed = abi.encodeWithSelector(SafeTransferLib.TransferFromFailed.selector, v);
        bytes memory backFailed = abi.encodeWithSelector(SafeTransferLib.TransferFailed.selector, v);
        bytes memory nothingOut = abi.encodeWithSelector(ExitRouter.NothingWithdrawn.selector);
        bytes memory clearSend = abi.encodeCall(IVaultV2.setSendSharesGate, (address(0)));
        bytes memory clearReceive = abi.encodeCall(IVaultV2.setReceiveSharesGate, (address(0)));
        bytes memory clearAssets = abi.encodeCall(IVaultV2.setReceiveAssetsGate, (address(0)));

        // Refuses the owner: the first transfer fails. The owner cannot redeem directly either.
        _simulatedCase(
            "send gate, refuses owner",
            abi.encodeCall(IVaultV2.setSendSharesGate, (address(new RefusingGate(everyone)))),
            clearSend, fromFailed, false
        );
        // Lets the owner send, refuses the adapter: redeem fails, then the adapter cannot hand the shares back.
        _simulatedCase(
            "send gate, refuses adapter",
            abi.encodeCall(IVaultV2.setSendSharesGate, (address(new RefusingGate(address(adapter))))),
            clearSend, backFailed, true
        );
        // The adapter may not hold shares: the first transfer fails. Direct redeem has no such check.
        _simulatedCase(
            "receive gate, refuses adapter",
            abi.encodeCall(IVaultV2.setReceiveSharesGate, (address(new RefusingGate(address(adapter))))),
            clearReceive, fromFailed, true
        );
        // The router may not take assets: redeem fails, shares come back, and nothing was delivered.
        _simulatedCase(
            "assets gate, refuses router",
            abi.encodeCall(IVaultV2.setReceiveAssetsGate, (address(new RefusingGate(address(router))))),
            clearAssets, nothingOut, true
        );
    }

    /// @dev `abdicated` alone says nothing about whether a gate is on, as OUSD Vault V2 shows. Launch vaults need both.
    function test_base_v2_launchVaultGatesAbdicatedAndUnset() public view {
        if (block.chainid != 8453) return;
        for (uint256 i; i < launchV2.length; ++i) {
            IVaultV2 g = IVaultV2(launchV2[i]);
            require(g.abdicated(IVaultV2.setSendSharesGate.selector), "send abdicated");
            require(g.abdicated(IVaultV2.setReceiveSharesGate.selector), "receive abdicated");
            require(g.abdicated(IVaultV2.setReceiveAssetsGate.selector), "assets abdicated");
            require(g.sendSharesGate() == address(0), "send unset");
            require(g.receiveSharesGate() == address(0), "receive unset");
            require(g.receiveAssetsGate() == address(0), "assets unset");
        }
    }
}
