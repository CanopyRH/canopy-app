// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AlarmBook} from "../src/AlarmBook.sol";
import {IERC20, IERC4626} from "../src/interfaces/IExternal.sol";

interface CkVm {
    function prank(address) external;
    function warp(uint256) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
}

interface ICkVaultV2 {
    function adaptersLength() external view returns (uint256);
    function adapters(uint256 i) external view returns (address);
    function liquidityAdapter() external view returns (address);
    function maxRate() external view returns (uint256);
    function lastUpdate() external view returns (uint64);
}

interface ICkAdapter {
    function marketIdsLength() external view returns (uint256);
    function marketIds(uint256 i) external view returns (bytes32);
}

interface ICkMorpho {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
    function supply(MarketParams memory p, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256, uint256);
}

interface ICkDeposit {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
}

/// @notice The audit's SHARE_DROP checkpoint lead, run against each launch vault on a Robinhood Chain fork.
///
/// The lead: `checkpoint` raises the SHARE_DROP high-water mark from a single reading. If a vault's share price
/// could be pushed up and back down inside one transaction, anyone could freeze a too-high mark in with
/// `checkpoint`, wait for the price to settle, and fire a false "Vault loss" alarm that exits real users.
///
/// Each attempt below does what such an attacker could do in one transaction, with a free flash loan modelled by
/// moving USDG out of Morpho Blue (the same way ForkTest funds depositors):
///   flashOnly          deposit a lot, checkpoint, redeem everything.
///   flashPlusDonation  deposit a lot, give the vault USDG directly, checkpoint, redeem everything.
///   donationThenFlash  give the vault USDG first, checkpoint, deposit a lot, checkpoint, redeem everything.
///   marketDonation     supply USDG into one of the vault adapter's Morpho markets on the adapter's behalf, which
///                      raises the vault's real assets without a share mint; then checkpoint, deposit, redeem.
/// Each runs twice: on the live state, and after the vault has sat untouched for 180 days, when the vault's
/// `maxRate` growth cap is at its loosest. The test fails if any attempt leaves the alarm able to fire.
///
/// Run: forge test --match-contract ForkCheckpointTest -vv --fork-url https://rpc.mainnet.chain.robinhood.com
contract ForkCheckpointTest {
    CkVm internal constant vm = CkVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    IERC20 internal constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    address internal constant MORPHO = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010;
    address internal constant ATTACKER = address(0xA77AC4);
    uint256 internal constant THRESHOLD_BPS = 50; // the "Vault loss" preset

    // The launch list in web/src/config.ts, the same one ForkTest uses.
    address[5] internal launchVaults = [
        0xBeEff033F34C046626B8D0A041844C5d1A5409dd, // Steakhouse USDG
        0xBEEff039907422219Fb367e525954DDC092854d9, // Grove x Steakhouse USDG
        0xd0dACE70434fF7567b108B5a8c2a36C150C830FE, // Galaxy USDG RH Stock Tokens
        0x8c258F25fc6fBe3f01ccC828E2C3840A46a4a9A2, // Yearn Stonk USDG
        0x37788ff0c1d4e45A7FE06BC7e71e0cc00121d0A8 // Purinta USDG
    ];
    string[4] internal attemptName = ["flashOnly", "flashPlusDonation", "donationThenFlash", "marketDonation"];

    AlarmBook internal book;
    uint256 internal worstGapBps; // the largest amount, in bps, a mark was left above the settled price
    uint256 internal attemptsRun;
    uint256 internal attemptsThatRaisedTheMark;

    struct Result {
        uint256 pxBefore;
        uint256 markBefore;
        uint256 pxPeak;
        uint256 markAfter;
        uint256 pxAfter;
        bool tripped;
        bool fired;
        string note; // empty when every step ran; otherwise why the attempt could not run in full
    }

    function setUp() public {
        if (block.chainid != 4663) return;
        book = new AlarmBook(address(this));
    }

    // ------------------------------------------------------------------ the test

    function test_fork_shareDropCheckpoint_everyLaunchVault() public {
        if (block.chainid != 4663) return;
        for (uint256 i; i < launchVaults.length; ++i) {
            address v = launchVaults[i];
            _describe(v);
            for (uint256 aged; aged < 2; ++aged) {
                for (uint256 a; a < 4; ++a) {
                    uint256 snap = vm.snapshotState();
                    Result memory r = _attempt(v, a, aged == 1);
                    vm.revertToState(snap);
                    _report(v, a, aged == 1, r);
                    attemptsRun++;
                    // The lead is real only if a settled vault could be made to fire. It must not be.
                    require(!r.tripped, "SHARE_DROP can be made to trip without a real loss: report this");
                    require(!r.fired, "poke fired a false Vault loss: report this");
                }
            }
        }
        emit log_named_uint("attempts run", attemptsRun);
        emit log_named_uint("attempts that raised the mark above the price it was registered at", attemptsThatRaisedTheMark);
        emit log_named_uint("worst gap left between the mark and the settled price, in bps", worstGapBps);
        require(attemptsRun == 40, "every vault and attempt ran");
    }

    // ------------------------------------------------------------------ one attempt

    function _px(address v) internal view returns (uint256) {
        return IERC4626(v).convertToAssets(10 ** IERC4626(v).decimals());
    }

    function _mark(bytes32 key) internal view returns (uint256 b) {
        (,,, b,) = book.state(key);
    }

    function _attempt(address v, uint256 attempt, bool aged) internal returns (Result memory r) {
        bytes32 key = book.register(
            AlarmBook.Detector({kind: AlarmBook.Kind.SHARE_DROP, target: v, threshold: THRESHOLD_BPS, window: 0, a: 0, b: 0})
        );
        r.markBefore = _mark(key);
        r.pxBefore = _px(v);
        if (aged) vm.warp(block.timestamp + 180 days);
        r.pxPeak = _px(v);

        uint256 tvl = IERC4626(v).totalAssets();
        uint256 donation = tvl / 50 > 1_000e6 ? tvl / 50 : 1_000e6; // enough to move the price about 2%
        uint256 flash = _fund(5_000_000e6 + donation);
        if (flash <= donation) {
            r.note = "Morpho Blue could not fund the attempt";
            return r;
        }
        flash -= donation;

        vm.prank(ATTACKER);
        USDG.approve(v, type(uint256).max);

        uint256 shares;
        if (attempt == 0) {
            shares = _deposit(v, flash);
            r.pxPeak = _max(r.pxPeak, _checkpoint(key, v));
        } else if (attempt == 1) {
            shares = _deposit(v, flash);
            vm.prank(ATTACKER);
            USDG.transfer(v, donation);
            r.pxPeak = _max(r.pxPeak, _checkpoint(key, v));
        } else if (attempt == 2) {
            vm.prank(ATTACKER);
            USDG.transfer(v, donation);
            r.pxPeak = _max(r.pxPeak, _checkpoint(key, v));
            shares = _deposit(v, flash);
            r.pxPeak = _max(r.pxPeak, _checkpoint(key, v));
        } else {
            if (!_donateIntoAdapterMarket(v, donation)) {
                r.note = "the vault's adapter holds no Morpho market to donate into";
            } else {
                r.pxPeak = _max(r.pxPeak, _checkpoint(key, v));
                shares = _deposit(v, flash);
                r.pxPeak = _max(r.pxPeak, _checkpoint(key, v));
            }
        }
        if (shares > 0) {
            vm.prank(ATTACKER);
            try IERC4626(v).redeem(shares, ATTACKER, ATTACKER) {} catch {
                r.note = "the attacker could not redeem, so the price never came back down";
            }
        }

        r.markAfter = _mark(key);
        r.pxAfter = _px(v);
        r.tripped = book.check(key);
        r.fired = book.poke(key);
    }

    function _checkpoint(bytes32 key, address v) internal returns (uint256 pxNow) {
        book.checkpoint(key);
        return _px(v);
    }

    /// @dev Moves USDG out of Morpho Blue to the attacker; returns what it got (all or nothing, at most `want`).
    function _fund(uint256 want) internal returns (uint256) {
        uint256 avail = USDG.balanceOf(MORPHO);
        uint256 amt = want <= avail / 2 ? want : avail / 2;
        vm.prank(MORPHO);
        require(USDG.transfer(ATTACKER, amt), "fund");
        return amt;
    }

    /// @dev Deposits, halving the amount if a cap refuses it. Returns the shares minted (0 if nothing went in).
    function _deposit(address v, uint256 amount) internal returns (uint256 shares) {
        while (amount >= 1_000e6) {
            vm.prank(ATTACKER);
            try ICkDeposit(v).deposit(amount, ATTACKER) returns (uint256 s) {
                return s;
            } catch {
                amount /= 2;
            }
        }
    }

    function _donateIntoAdapterMarket(address v, uint256 amount) internal returns (bool) {
        address adapter;
        try ICkVaultV2(v).adapters(0) returns (address a) {
            adapter = a;
        } catch {
            return false;
        }
        bytes32 id;
        try ICkAdapter(adapter).marketIds(0) returns (bytes32 m) {
            id = m;
        } catch {
            return false;
        }
        ICkMorpho.MarketParams memory p = ICkMorpho(MORPHO).idToMarketParams(id);
        vm.prank(ATTACKER);
        USDG.approve(MORPHO, type(uint256).max);
        vm.prank(ATTACKER);
        try ICkMorpho(MORPHO).supply(p, amount, 0, adapter, "") {
            return true;
        } catch {
            return false;
        }
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    // ------------------------------------------------------------------ reporting

    function _describe(address v) internal {
        emit log_string("------------------------------------------------");
        emit log_string(IERC4626Name(v).name());
        emit log_named_uint("  TVL (USDG)", IERC4626(v).totalAssets() / 1e6);
        emit log_named_uint("  adapters", _tryUint(v, ICkVaultV2.adaptersLength.selector));
        emit log_named_uint("  has liquidity adapter (1 = yes)", ICkVaultV2(v).liquidityAdapter() == address(0) ? 0 : 1);
        emit log_named_uint("  maxRate (per second, 1e18 = 100%)", _tryUint(v, ICkVaultV2.maxRate.selector));
        emit log_named_uint("  seconds since the last accrual", block.timestamp - _tryUint(v, ICkVaultV2.lastUpdate.selector));
    }

    function _tryUint(address target, bytes4 sel) internal view returns (uint256 x) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSelector(sel));
        if (ok && ret.length >= 32) x = abi.decode(ret, (uint256));
    }

    function _report(address v, uint256 a, bool aged, Result memory r) internal {
        v;
        emit log_string(string.concat("  ", attemptName[a], aged ? " (after 180 idle days)" : " (live state)", bytes(r.note).length == 0 ? "" : string.concat("  [not run in full: ", r.note, "]")));
        emit log_named_uint("    price at registration, per 1e18 shares", r.pxBefore);
        emit log_named_uint("    price at its highest during the attempt", r.pxPeak);
        emit log_named_uint("    mark after the attempt", r.markAfter);
        emit log_named_uint("    price once it settled", r.pxAfter);
        if (r.markAfter > r.markBefore) attemptsThatRaisedTheMark++;
        if (r.markAfter > r.pxAfter) {
            uint256 gap = ((r.markAfter - r.pxAfter) * 10_000) / r.pxAfter;
            emit log_named_uint("    mark above settled price, bps", gap);
            if (gap > worstGapBps) worstGapBps = gap;
        } else {
            emit log_string("    mark is at or below the settled price: nothing stuck high");
        }
        emit log_string(r.tripped ? "    ALARM CAN FIRE" : "    alarm cannot fire");
    }

    event log_string(string val);
    event log_named_uint(string key, uint256 val);
}

interface IERC4626Name {
    function name() external view returns (string memory);
}
