// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitRouter} from "../src/ExitRouter.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {IERC20, IERC4626} from "../src/interfaces/IExternal.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {ForkDeploy} from "./Fork.t.sol";

interface PresetVm {
    function prank(address) external;
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function cool(address) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
}

interface IPresetDeposit {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
}

/// @notice v2 on a Robinhood Chain fork, deployed by script/Deploy.s.sol: every launch vault's seven preset detectors
/// (web/src/config.ts vaults, services/src/api/presets.ts registrationOrder) register, read clear, are armable, and
/// can't be fired by a flash deposit or a donation. It also measures the gas each preset reading takes on each vault,
/// the basis for AlarmBook.TARGET_READ_GAS.
///
/// Run: forge test --match-contract ForkPresetsTest -vv --fork-url https://rpc.mainnet.chain.robinhood.com
contract ForkPresetsTest {
    PresetVm internal constant vm = PresetVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    IERC20 internal constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    address internal constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address internal constant ATTACKER = address(0xA77AC4);
    uint256 internal constant NP = 7;

    address[5] internal launchVaults = [
        0xBeEff033F34C046626B8D0A041844C5d1A5409dd, // Steakhouse USDG
        0xBEEff039907422219Fb367e525954DDC092854d9, // Grove x Steakhouse USDG
        0xd0dACE70434fF7567b108B5a8c2a36C150C830FE, // Galaxy USDG RH Stock Tokens
        0x8c258F25fc6fBe3f01ccC828E2C3840A46a4a9A2, // Yearn Stonk USDG
        0x37788ff0c1d4e45A7FE06BC7e71e0cc00121d0A8 // Purinta USDG
    ];
    string[NP] internal presetName =
        ["Vault loss", "Exploit confirmed", "Paused", "Vault drain", "Vault drain + confirmation", "Curator change", "Curator change + confirmation"];

    AlarmBook internal book;
    ExitRouter internal router;
    ERC4626Adapter internal adapter;

    event log_string(string val);
    event log_named_uint(string key, uint256 val);

    function setUp() public {
        if (block.chainid != 4663) return;
        address[] memory ws = new address[](2);
        ws[0] = vm.addr(0xA1);
        ws[1] = vm.addr(0xB2);
        Deploy.Deployed memory d = ForkDeploy.run(ws);
        book = d.book;
        router = d.router;
        adapter = d.adapter;
    }

    // ------------------------------------------------------------------ the presets, as services/src/api/presets.ts builds them

    function _d(AlarmBook.Kind k, address t, uint256 th, uint32 w, bytes32 a, bytes32 b)
        internal
        pure
        returns (AlarmBook.Detector memory)
    {
        return AlarmBook.Detector({kind: k, target: t, threshold: th, window: w, a: a, b: b});
    }

    /// @dev registrationOrder(vault): SHARE_DROP, QUORUM, PAUSED, DRAIN, BOTH(drain, quorum), ADDRESS_CHANGE, BOTH(curator, quorum).
    function _register(address v) internal returns (bytes32[NP] memory k) {
        k[0] = book.register(_d(AlarmBook.Kind.SHARE_DROP, v, 50, 0, 0, 0));
        k[1] = book.register(_d(AlarmBook.Kind.QUORUM, v, 2, 0, 0, 0));
        k[2] = book.register(_d(AlarmBook.Kind.PAUSED, v, 0, 0, 0, 0));
        k[3] = book.register(_d(AlarmBook.Kind.DRAIN, v, 2500, 3600, 0, 0));
        k[4] = book.register(_d(AlarmBook.Kind.BOTH, v, 0, 86_400, k[3], k[1]));
        k[5] = book.register(_d(AlarmBook.Kind.ADDRESS_CHANGE, v, 0, 0, bytes32(bytes4(keccak256("curator()"))), 0));
        k[6] = book.register(_d(AlarmBook.Kind.BOTH, v, 0, 86_400, k[5], k[1]));
    }

    /// @dev Every preset key but the bare DRAIN part (index 3), which the router only accepts inside BOTH.
    function _keys(bytes32[NP] memory k) internal pure returns (bytes32[] memory a) {
        a = new bytes32[](NP - 1);
        uint256 n;
        for (uint256 i; i < NP; ++i) {
            if (i != 3) a[n++] = k[i];
        }
    }

    function _params(address v, bytes32[] memory ks) internal view returns (ExitRouter.ArmParams memory) {
        return ExitRouter.ArmParams({
            adapter: address(adapter),
            target: v,
            tokenId: 0,
            harbour: 0,
            maxSlipBps: 0,
            termsHash: keccak256("terms-v2"),
            keys: ks,
            swaps: new ExitRouter.SwapLeg[](0)
        });
    }

    function _pendingAt(bytes32 k) internal view returns (uint64 p) {
        (,,,,,, p,) = book.state(k);
    }

    // ------------------------------------------------------------------ register, read clear, arm

    function test_fork_everyPresetRegistersReadsClearAndArms() public {
        if (block.chainid != 4663) return;
        for (uint256 i; i < launchVaults.length; ++i) {
            address v = launchVaults[i];
            bytes32[NP] memory k = _register(v);
            for (uint256 p; p < NP; ++p) {
                require(!book.check(k[p]), string.concat(presetName[p], ": reads tripped"));
                require(book.armable(k[p]), string.concat(presetName[p], ": not armable"));
            }

            // A fresh depositor arms the presets at once, in v2's constructor-allowed adapter: all but the bare DRAIN
            // part, which the router refuses on its own (it only counts inside "Vault drain + confirmation").
            address user = address(uint160(0xC0FFEE00 + i));
            vm.prank(MORPHO);
            require(USDG.transfer(user, 1_000e6), "fund");
            vm.prank(user);
            require(USDG.approve(v, 1_000e6), "approve vault");
            vm.prank(user);
            IPresetDeposit(v).deposit(1_000e6, user);
            vm.prank(user);
            require(IERC20(v).approve(address(router), type(uint256).max), "approve router");
            bytes32[] memory bare = new bytes32[](1);
            bare[0] = k[3];
            vm.prank(user);
            try router.arm(_params(v, bare)) {
                revert("a bare DRAIN key was armed");
            } catch (bytes memory err) {
                require(bytes4(err) == ExitRouter.DrainNeedsQuorum.selector, "refused with DrainNeedsQuorum");
            }
            vm.prank(user);
            bytes32 id = router.arm(_params(v, _keys(k)));
            require(router.isArmed(id), "armed");

            // After a keeper's routine samples over two periods the DRAIN reference is live, and the vault still reads
            // clear.
            uint256 snap = vm.snapshotState();
            for (uint256 r; r < 2; ++r) {
                vm.warp(block.timestamp + 1800);
                book.checkpoint(k[3]);
                book.checkpoint(k[0]);
            }
            (,,,, uint256 dSnap,,, uint256 dPrev) = book.state(k[3]);
            require(dSnap != 0 && dPrev != 0, "the DRAIN reference is live");
            for (uint256 p; p < NP; ++p) {
                require(!book.check(k[p]) && book.armable(k[p]), string.concat(presetName[p], ": not clear after sampling"));
            }
            vm.revertToState(snap);
            emit log_string(string.concat(IName(v).name(), ": 7 presets registered, clear and armable; 6 armed, the bare DRAIN refused"));
        }
    }

    // ------------------------------------------------------------------ a flash deposit or a donation can't fire them

    function _fund(uint256 want) internal returns (uint256 amt) {
        uint256 avail = USDG.balanceOf(MORPHO);
        amt = want <= avail / 2 ? want : avail / 2;
        vm.prank(MORPHO);
        require(USDG.transfer(ATTACKER, amt), "fund");
    }

    function _deposit(address v, uint256 amount) internal returns (uint256 shares) {
        while (amount >= 1_000e6) {
            vm.prank(ATTACKER);
            try IPresetDeposit(v).deposit(amount, ATTACKER) returns (uint256 s) {
                return s;
            } catch {
                amount /= 2;
            }
        }
    }

    function _pokeAll(bytes32[NP] memory k) internal returns (uint256 fired) {
        for (uint256 p; p < NP; ++p) {
            if (book.poke(k[p])) fired++;
        }
    }

    function _checkpointAll(bytes32[NP] memory k) internal {
        for (uint256 p; p < NP; ++p) {
            book.checkpoint(k[p]);
        }
    }

    function _noneFiredOrPending(bytes32[NP] memory k, string memory when) internal view {
        for (uint256 p; p < NP; ++p) {
            require(!book.isLive(k[p], 1 days), string.concat(presetName[p], " fired ", when));
            require(!book.check(k[p]), string.concat(presetName[p], " reads tripped ", when));
        }
        require(_pendingAt(k[3]) == 0, string.concat("a drain confirmation started ", when));
    }

    function test_fork_flashDepositAndDonationCantFireAnyPreset() public {
        if (block.chainid != 4663) return;
        for (uint256 i; i < launchVaults.length; ++i) {
            address v = launchVaults[i];
            bytes32[NP] memory k = _register(v);
            vm.warp(block.timestamp + 1800);
            _checkpointAll(k);
            vm.warp(block.timestamp + 1800);
            _checkpointAll(k); // two periods sampled: the DRAIN reference is live from here on

            uint256 tvl = IERC4626(v).totalAssets();
            uint256 donation = tvl / 50 > 1_000e6 ? tvl / 50 : 1_000e6;
            uint256 cash = _fund(5_000_000e6 + donation);
            vm.prank(ATTACKER);
            USDG.approve(v, type(uint256).max);

            // 1. Flash deposit: deposit, poke and sample everything at the inflated level, redeem.
            uint256 shares = _deposit(v, cash - donation);
            require(_pokeAll(k) == 0, "fired inside the flash deposit");
            _checkpointAll(k);
            _checkpointAll(k);
            if (shares > 0) {
                vm.prank(ATTACKER);
                try IERC4626(v).redeem(shares, ATTACKER, ATTACKER) {} catch {}
            }
            require(_pokeAll(k) == 0, "fired after the flash deposit");
            _noneFiredOrPending(k, "after a flash deposit");

            // 2. Donation straight to the vault, then sample and poke; and a minute later, when a drain could confirm.
            vm.prank(ATTACKER);
            require(USDG.transfer(v, donation), "donate");
            _checkpointAll(k);
            require(_pokeAll(k) == 0, "fired after a donation");
            vm.warp(block.timestamp + 60);
            require(_pokeAll(k) == 0, "fired a minute after a donation");
            _noneFiredOrPending(k, "after a donation");
            for (uint256 p; p < NP; ++p) {
                require(book.armable(k[p]), string.concat(presetName[p], " not armable after the attempts"));
            }
            emit log_string(string.concat(IName(v).name(), ": no preset fired or started a confirmation"));
        }
    }

    // ------------------------------------------------------------------ read gas, the basis for TARGET_READ_GAS

    /// @dev Gas for one target read, measured cold: every account the read touches is cooled first, so this is what the
    /// read costs as the first thing in a transaction.
    function _cold(address v, bytes memory data, address[] memory touched) internal returns (uint256 used, bool ok) {
        for (uint256 i; i < touched.length; ++i) {
            vm.cool(touched[i]);
        }
        uint256 g0 = gasleft();
        (ok,) = v.staticcall(data);
        used = g0 - gasleft();
    }

    function test_fork_presetReadGas_everyLaunchVault() public {
        if (block.chainid != 4663) return;
        uint256 cap = book.TARGET_READ_GAS();
        uint256 worst;
        // The vaults, their adapters and Morpho Blue: everything a reading can reach. Cooling an account that a read does
        // not touch changes nothing.
        address[] memory touched = new address[](launchVaults.length + 1);
        for (uint256 i; i < launchVaults.length; ++i) {
            touched[i] = launchVaults[i];
        }
        touched[launchVaults.length] = MORPHO;
        bytes[5] memory reads = [
            abi.encodeWithSignature("decimals()"),
            abi.encodeWithSignature("convertToAssets(uint256)", 1e18),
            abi.encodeWithSignature("totalAssets()"),
            abi.encodeWithSignature("paused()"),
            abi.encodeWithSignature("curator()")
        ];
        string[5] memory names = ["decimals", "convertToAssets", "totalAssets", "paused (reverts: no such view)", "curator"];
        for (uint256 i; i < launchVaults.length; ++i) {
            address v = launchVaults[i];
            address[] memory all = _withAdapters(v, touched);
            emit log_string(IName(v).name());
            for (uint256 r; r < 5; ++r) {
                (uint256 used, bool ok) = _cold(v, reads[r], all);
                require(ok == (r != 3), "read outcome");
                emit log_named_uint(string.concat("  ", names[r]), used);
                if (used > worst) worst = used;
            }
        }
        emit log_named_uint("worst single read", worst);
        emit log_named_uint("TARGET_READ_GAS", cap);
        emit log_named_uint("headroom, x100", (cap * 100) / worst);
        // The cap was set at about 4x the worst reading measured (248,221 gas, Steakhouse USDG, 2026-11-06). Fail well
        // before a reading could reach it, but leave room for a vault to add a market or two.
        require(worst * 3 <= cap, "less than 3x headroom under TARGET_READ_GAS: re-measure and raise the cap");
    }

    function _word(address t, bytes memory data) internal view returns (bool ok, uint256 w) {
        bytes memory ret;
        (ok, ret) = t.staticcall(data);
        ok = ok && ret.length >= 32;
        if (ok) w = abi.decode(ret, (uint256));
    }

    /// @dev Adds what a Morpho Vault V2 reading reaches beyond the vault and Morpho Blue: the vault's adapters, and the
    /// interest-rate model of every market those adapters hold, so the cooled measurement is a true first-touch cost.
    function _withAdapters(address v, address[] memory base) internal view returns (address[] memory all) {
        address[] memory buf = new address[](base.length + 80);
        uint256 n;
        for (; n < base.length; ++n) {
            buf[n] = base[n];
        }
        (bool ok, uint256 na) = _word(v, abi.encodeWithSignature("adaptersLength()"));
        if (!ok || na > 8) na = 0;
        for (uint256 j; j < na; ++j) {
            (, uint256 a) = _word(v, abi.encodeWithSignature("adapters(uint256)", j));
            buf[n++] = address(uint160(a));
            (bool okM, uint256 nm) = _word(address(uint160(a)), abi.encodeWithSignature("marketIdsLength()"));
            if (!okM || nm > 8) nm = 0;
            for (uint256 m; m < nm; ++m) {
                (, uint256 id) = _word(address(uint160(a)), abi.encodeWithSignature("marketIds(uint256)", m));
                (bool okP, bytes memory p) = MORPHO.staticcall(abi.encodeWithSignature("idToMarketParams(bytes32)", bytes32(id)));
                if (okP && p.length >= 160) {
                    (,,, address irm,) = abi.decode(p, (address, address, address, address, uint256));
                    buf[n++] = irm;
                }
            }
        }
        all = new address[](n);
        for (uint256 i; i < n; ++i) {
            all[i] = buf[i];
        }
    }
}

interface IName {
    function name() external view returns (string memory);
}
