// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "./Base.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {MockERC20, MockVault, MockFeed, MockSwapRouter, MockPausable} from "./Mocks.sol";

// Stateful invariant suite for ExitRouter.
//
// A handler contract drives random sequences of arm, disarm, disarmAll, alarm pokes, exits (by the owner, a
// keeper and strangers), failed deliveries (an owner who cannot receive a token, so it is booked as owed),
// claimOwed, vault liquidity changes, price drops, swap knobs, donations to the router and time travel, across
// three owners, four vaults and seven tokens (stablecoin, two other assets, and the four vaults' share tokens). The
// fourth vault's asset is its own share token, which makes one token appear twice in an exit's output list.
//
// Run it with the invariant profile (at least 100,000 calls):
//   FOUNDRY_PROFILE=invariant forge test --match-path test/RouterInvariant.t.sol
// The default `forge test` runs only a short smoke pass of the same suite (see the forge-config line below).

/// @dev Records every transfer out of the router. The handler tells it who the only allowed recipient is.
contract Ledger {
    address public router;
    address public swapRouter;
    address public expected; // the position owner while an exit or claim runs, otherwise zero
    uint256 public strangersPaid; // transfers out of the router to anyone but `expected`
    uint256 public badSpender; // pulls out of the router by anything but the swap router, or to anywhere but the swap router
    uint256 public ownerPayouts;
    uint256 public swapPulls;
    address[] public swapToken; // the legs of the exit in progress: what the swap router pulled, and how much
    uint256[] public swapIn;

    function init(address r, address s) external {
        router = r;
        swapRouter = s;
    }

    function setExpected(address e) external {
        expected = e;
    }

    function noteTransfer(address to) external {
        if (to == address(0) || to != expected) strangersPaid++;
        else ownerPayouts++;
    }

    function noteTransferFrom(address spender, address to, address token, uint256 amount) external {
        if (spender != swapRouter || to != swapRouter) {
            badSpender++;
        } else {
            swapPulls++;
            swapToken.push(token);
            swapIn.push(amount);
        }
    }

    function swapCount() external view returns (uint256) {
        return swapToken.length;
    }

    function clearSwaps() external {
        delete swapToken;
        delete swapIn;
    }
}

contract TrackedToken is MockERC20 {
    Ledger internal immutable ledger;

    constructor(uint8 d, Ledger l) MockERC20(d) {
        ledger = l;
    }

    function transfer(address to, uint256 a) public override returns (bool) {
        if (msg.sender == ledger.router()) ledger.noteTransfer(to);
        return super.transfer(to, a);
    }

    function transferFrom(address f, address t, uint256 a) public override returns (bool) {
        if (f == ledger.router()) ledger.noteTransferFrom(msg.sender, t, address(this), a);
        return super.transferFrom(f, t, a);
    }
}

contract TrackedVault is MockVault {
    Ledger internal immutable ledger;

    constructor(MockERC20 a, uint256 pps, Ledger l) MockVault(a, pps) {
        ledger = l;
    }

    function transfer(address to, uint256 a) public override returns (bool) {
        if (msg.sender == ledger.router()) ledger.noteTransfer(to);
        return super.transfer(to, a);
    }

    function transferFrom(address f, address t, uint256 a) public override returns (bool) {
        if (f == ledger.router()) ledger.noteTransferFrom(msg.sender, t, address(this), a);
        return super.transferFrom(f, t, a);
    }
}

/// @dev What the handler needs from any vault, so the self-asset vault and the mock vaults can share code.
interface IVault {
    function deposit(address to, uint256 shares) external;
    function assetsPerShare() external view returns (uint256);
    function setPrice(uint256 pps) external;
    function setLiquid(uint256 l) external;
    function setZeroMax(bool z) external;
    function convertToAssets(uint256 s) external view returns (uint256);
}

/// @dev A vault whose asset is its own share token. A redeem pays a little stablecoin and leaves every share
/// unredeemed, so the router sees the same token as both an output and a leftover. Price and liquidity knobs do nothing.
contract TrackedSelfVault is MockERC20 {
    Ledger internal immutable ledger;
    MockERC20 internal immutable stableToken;

    constructor(MockERC20 s, Ledger l) MockERC20(18) {
        stableToken = s;
        ledger = l;
    }

    function transfer(address to, uint256 a) public override returns (bool) {
        if (msg.sender == ledger.router()) ledger.noteTransfer(to);
        return super.transfer(to, a);
    }

    function transferFrom(address f, address t, uint256 a) public override returns (bool) {
        if (f == ledger.router()) ledger.noteTransferFrom(msg.sender, t, address(this), a);
        return super.transferFrom(f, t, a);
    }

    function asset() external view returns (address) {
        return address(this);
    }

    function deposit(address to, uint256 shares) external {
        mint(to, shares);
    }

    function assetsPerShare() external pure returns (uint256) {
        return 1e18;
    }

    function setPrice(uint256) external {}
    function setLiquid(uint256) external {}
    function setZeroMax(bool) external {}

    function convertToAssets(uint256 s) external pure returns (uint256) {
        return s;
    }

    function maxRedeem(address) external pure returns (uint256) {
        return 0;
    }

    function totalAssets() external view returns (uint256) {
        return totalSupply;
    }

    function redeem(uint256, address receiver, address) external returns (uint256) {
        stableToken.mint(receiver, 1e6);
        return 0;
    }
}

contract RouterHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant NT = 7; // stable, tokenA, tokenB, then the share tokens of vaults 0 to 3
    uint256 internal constant NO = 3;
    uint256 internal constant NV = 4;
    uint256 internal constant NK = 3;

    ExitRouter public router;
    AlarmBook public book;
    ERC4626Adapter public adapter;
    Ledger public ledger;
    MockSwapRouter public swap;
    MockFeed public stableFeed;
    MockFeed[2] internal feeds; // for tokenA and tokenB
    MockPausable[2] internal pausables;
    address[NV] public vaults;
    MockERC20[NT] public tokens;
    bytes32[NK] public keys;
    address[NO] public owners;
    address public keeper;
    address[2] public strangers;
    address internal admin;
    address internal guardian;
    uint256 internal startTime;

    // ghost model of who is armed, with which keys, and since when
    bool[NV][NO] internal gArmed;
    uint8[NV][NO] internal gMask;
    uint64[NV][NO] internal gArmedAt;
    uint16[NV][NO] internal gSlip;
    // ghost model of the alarms: the time each key last fired, kept here and never read back from AlarmBook.isLive
    uint64[NK] internal gFiredAt;
    uint256 internal expiry; // the router's ADMIN_EXPIRY, as the handler expects it

    mapping(address => uint256) public donated; // tokens sent straight to the router
    uint256[NT] internal sumOwedSeen;

    // findings the invariants read
    uint256 public leftFreeBalance; // an exit or claim changed the router's free (not owed) balance
    uint256 public disarmedExitByStranger; // a non-owner exit succeeded on a position the model says is not armed
    uint256 public unauthorizedExitByStranger; // a non-owner exit succeeded without an armed, live key
    uint256 public strangerDisarmed; // a non-owner disarm succeeded
    uint256 public claimPaidSomeoneElse; // claimOwed succeeded but the named owner's owed balance did not drop
    uint256 public alarmModelRefusals; // the model says a non-owner exit is allowed, and the router refused it for alarm reasons
    uint256 public adminPowerAfterExpiry; // an admin or guardian call succeeded at or after ADMIN_EXPIRY
    uint256 public swapBelowOracleMin; // a swap paid less than the handler's own oracle minimum
    uint256 public thirdPartySwapOverSlipCap; // a swap in an exit run by a non-owner paid more than 1% under the oracle

    // coverage counters
    uint256 public okArm;
    uint256 public okOwnerExit;
    uint256 public okKeeperExit;
    uint256 public okStrangerExit;
    uint256 public deniedStrangerExit;
    uint256 public okClaim;
    uint256 public okDisarm;
    uint256 public okDisarmAll;
    uint256 public pokesFired;
    uint256 public owedBooked;
    uint256 public adminRevertedAfterExpiry;
    uint256 public swapsChecked;
    uint256 public thirdPartySwapsChecked;

    constructor() {
        startTime = block.timestamp;
        expiry = block.timestamp + 365 days;
        admin = address(0xAD);
        guardian = address(0x6A);
        keeper = address(0xB0B);
        strangers = [address(0xBAD1), address(0xBAD2)];
        owners = [address(0xA11CE01), address(0xA11CE02), address(0xA11CE03)];

        ledger = new Ledger();
        TrackedToken stable = new TrackedToken(6, ledger);
        TrackedToken tokA = new TrackedToken(18, ledger);
        TrackedToken tokB = new TrackedToken(18, ledger);
        stableFeed = new MockFeed(1e8);
        swap = new MockSwapRouter(stable);
        swap.setRate(1e6); // $1 per token
        book = new AlarmBook(admin);
        router = new ExitRouter(
            address(stable), address(0x0E7E), address(swap), address(book), admin, guardian, address(stableFeed), 90_000,
            expiry
        );
        ledger.init(address(router), address(swap));
        adapter = new ERC4626Adapter(address(router));
        vm.prank(admin);
        router.setAdapter(address(adapter), true);

        TrackedVault v0 = new TrackedVault(stable, 1e6, ledger); // 1 share = 1 USD
        TrackedVault v1 = new TrackedVault(tokA, 1e18, ledger); // 1 share = 1 tokenA
        TrackedVault v2 = new TrackedVault(tokB, 1e18, ledger);
        TrackedSelfVault v3 = new TrackedSelfVault(stable, ledger);
        vaults = [address(v0), address(v1), address(v2), address(v3)];
        tokens[0] = stable;
        tokens[1] = tokA;
        tokens[2] = tokB;
        tokens[3] = v0;
        tokens[4] = v1;
        tokens[5] = v2;
        tokens[6] = v3;

        for (uint256 i; i < 2; ++i) {
            feeds[i] = new MockFeed(1e8);
            vm.startPrank(admin);
            router.setFeed(address(tokens[i + 1]), address(feeds[i]), 3600, 18);
            router.setRoute(address(tokens[i + 1]), abi.encodePacked(address(tokens[i + 1]), uint24(500), address(stable)));
            vm.stopPrank();
            pausables[i] = new MockPausable();
            keys[i] = book.register(
                AlarmBook.Detector({kind: AlarmBook.Kind.PAUSED, target: address(pausables[i]), threshold: 0, window: 0, a: 0, b: 0})
            );
        }
        v0.deposit(address(this), 1000e18); // gives the share-drop detector a price to read
        keys[2] = book.register(
            AlarmBook.Detector({kind: AlarmBook.Kind.SHARE_DROP, target: address(v0), threshold: 50, window: 0, a: 0, b: 0})
        );

        // Every owner starts with shares in every vault, approved to the router, so sequences reach exits quickly.
        for (uint256 o; o < NO; ++o) {
            for (uint256 v; v < NV; ++v) {
                IVault(vaults[v]).deposit(owners[o], 1000e18);
                vm.prank(owners[o]);
                tokens[3 + v].approve(address(router), type(uint256).max);
            }
        }
    }

    // ------------------------------------------------------------------ views for the invariants

    function owner(uint256 i) external view returns (address) {
        return owners[i];
    }

    function token(uint256 i) external view returns (MockERC20) {
        return tokens[i];
    }

    function free(uint256 i) public view returns (uint256) {
        uint256 bal = tokens[i].balanceOf(address(router));
        uint256 o = router.totalOwed(address(tokens[i]));
        return bal > o ? bal - o : 0;
    }

    // ------------------------------------------------------------------ helpers

    function _b(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + (x % (hi - lo + 1));
    }

    function _posId(uint256 o, uint256 v) internal view returns (bytes32) {
        return router.positionId(owners[o], address(adapter), vaults[v], 0);
    }

    function _snapshotFree() internal view returns (uint256[NT] memory f) {
        for (uint256 i; i < NT; ++i) {
            f[i] = free(i);
        }
    }

    function _checkFree(uint256[NT] memory before) internal {
        for (uint256 i; i < NT; ++i) {
            if (free(i) != before[i]) leftFreeBalance++;
        }
    }

    function _totalOwed() internal view returns (uint256 t) {
        for (uint256 i; i < NT; ++i) {
            t += router.totalOwed(address(tokens[i]));
        }
    }

    // ------------------------------------------------------------------ owner-side actions

    /// @dev Mostly tops up a position that is armed, so it has something left to exit.
    function deposit(uint256 oi, uint256 vi, uint256 shares) external {
        uint256 o = oi % NO;
        uint256 v = vi % NV;
        if (shares % 4 != 0) (o, v) = _pickArmed(oi, o, v);
        IVault(vaults[v]).deposit(owners[o], _b(shares >> 8, 1e18, 500e18));
    }

    function setApproval(uint256 oi, uint256 vi, uint256 seed) external {
        uint256 k = seed % 8;
        uint256 amt = k == 0 ? 0 : k == 1 ? _b(seed >> 8, 1e18, 800e18) : type(uint256).max;
        vm.prank(owners[oi % NO]);
        tokens[3 + (vi % NV)].approve(address(router), amt);
    }

    function arm(uint256 oi, uint256 vi, uint256 harbour, uint256 slip, uint256 mask) external {
        uint256 o = oi % NO;
        uint256 v = vi % NV;
        uint8 m = mask % 5 == 0 ? 0 : uint8(1 + (mask >> 4) % 7); // mostly non-empty
        bytes32[] memory ks = new bytes32[](_pop(m));
        uint256 n;
        for (uint256 k; k < NK; ++k) {
            if ((m >> k) & 1 == 1) ks[n++] = keys[k];
        }
        ExitRouter.ArmParams memory p = ExitRouter.ArmParams({
            adapter: address(adapter),
            target: vaults[v],
            tokenId: 0,
            harbour: uint8(harbour % 3), // 2 is invalid and must be refused
            maxSlipBps: uint16(slip % 1101), // above 1000 must be refused
            termsHash: keccak256("terms"),
            keys: ks
        });
        ledger.setExpected(address(0));
        vm.prank(owners[o]);
        try router.arm(p) {
            gArmed[o][v] = true;
            gMask[o][v] = m;
            gArmedAt[o][v] = uint64(block.timestamp);
            gSlip[o][v] = uint16(slip % 1101);
            okArm++;
        } catch {}
    }

    function _pop(uint8 m) internal pure returns (uint256 c) {
        for (uint256 k; k < NK; ++k) {
            c += (m >> k) & 1;
        }
    }

    function disarm(uint256 oi, uint256 vi, bool byStranger) external {
        uint256 o = oi % NO;
        uint256 v = vi % NV;
        bytes32 id = _posId(o, v); // computed first: a prank applies to the very next external call
        ledger.setExpected(address(0));
        vm.prank(byStranger ? strangers[oi % 2] : owners[o]);
        try router.disarm(id) {
            if (byStranger) {
                strangerDisarmed++;
            } else {
                gArmed[o][v] = false;
                okDisarm++;
            }
        } catch {}
    }

    /// @dev Rare on purpose: each call switches off every position of that owner.
    function disarmAll(uint256 oi) external {
        if (oi % 10 != 0) return;
        uint256 o = (oi >> 8) % NO;
        ledger.setExpected(address(0));
        vm.prank(owners[o]);
        router.disarmAll();
        for (uint256 v; v < NV; ++v) {
            gArmed[o][v] = false;
        }
        okDisarmAll++;
    }

    // ------------------------------------------------------------------ alarms and the world

    /// @dev Short steps, so an alarm stays live (24 h) across several calls; sometimes a long jump past it.
    function warp(uint256 dt) external {
        if (dt % 3 != 0 || block.timestamp > startTime + 450 days) return;
        vm.warp(block.timestamp + ((dt >> 8) % 16 == 0 ? _b(dt >> 16, 1 days, 3 days) : _b(dt >> 16, 1, 6 hours)));
    }

    /// @dev Rare: lands on a second from the expiry itself to 30 days after it, so later calls run with the admin's time over.
    function jumpPastExpiry(uint256 seed) external {
        if (seed % 8 != 0 || block.timestamp >= expiry) return;
        vm.warp(expiry + _b(seed >> 8, 0, 30 days));
    }

    function setPaused(uint256 pi, bool p) external {
        pausables[pi % 2].setPaused(p);
    }

    function poke(uint256 ki, uint256 ci) external {
        ledger.setExpected(address(0));
        vm.prank(strangers[ci % 2]);
        try book.poke(keys[ki % NK]) returns (bool fired) {
            if (fired) {
                pokesFired++;
                gFiredAt[ki % NK] = uint64(block.timestamp);
            }
        } catch {}
    }

    function checkpoint(uint256 ki) external {
        book.checkpoint(keys[ki % NK]);
    }

    function dropPrice(uint256 vi, uint256 bps) external {
        if (bps % 3 != 0) return;
        bps >>= 8;
        IVault v = IVault(vaults[vi % NV]);
        uint256 pps = v.assetsPerShare();
        uint256 np = (pps * (10_000 - _b(bps, 0, 300))) / 10_000;
        if (np > 0) v.setPrice(np);
    }

    /// @dev One call in four leaves the vault short of cash (partial or failed redeems); the rest make it fully liquid.
    function setLiquidity(uint256 vi, uint256 low, uint256 seed, bool zeroMax) external {
        IVault v = IVault(vaults[vi % NV]);
        v.setLiquid(low % 4 == 0 ? _b(seed, 0, v.convertToAssets(2000e18)) : v.convertToAssets(100_000e18));
        v.setZeroMax(zeroMax);
    }

    /// @dev Blocks an owner from receiving a token (so a payout is booked as owed), or lifts the block, or does nothing.
    function setBlocked(uint256 oi, uint256 ti, uint256 mode) external {
        uint256 m = mode % 6;
        if (m < 2) tokens[ti % NT].setBlocked(owners[oi % NO], true);
        else if (m == 2) tokens[ti % NT].setBlocked(owners[oi % NO], false);
    }

    function donate(uint256 ti, uint256 amt) external {
        MockERC20 t = tokens[ti % NT];
        uint256 a = _b(amt, 1, 100e6);
        t.mint(address(router), a);
        donated[address(t)] += a;
    }

    function swapKnobs(uint256 rate, uint256 mode) external {
        swap.setRate(_b(rate, 0.9e6, 1.1e6));
        swap.setBroken(mode % 4 == 0);
        stableFeed.set((mode >> 8) % 5 == 0 ? int256(0.9e8) : int256(1e8), block.timestamp);
    }

    function refreshFeeds(uint256 price) external {
        stableFeed.set(stableFeed.answer(), block.timestamp);
        for (uint256 i; i < 2; ++i) {
            feeds[i].set(int256(_b(price >> (i * 64), 0.9e8, 1.1e8)), block.timestamp);
        }
    }

    function adminSetFeed(uint256 ti) external {
        if (ti % 6 != 0) return;
        uint256 i = (ti >> 8) % 2;
        ledger.setExpected(address(0));
        vm.prank(admin);
        try router.setFeed(address(tokens[i + 1]), address(feeds[i]), 3600, 18) { // bumps swapConfig
            if (block.timestamp >= expiry) adminPowerAfterExpiry++;
        } catch {
            if (block.timestamp >= expiry) adminRevertedAfterExpiry++;
        }
    }

    /// @dev Once ADMIN_EXPIRY has passed, every admin call and every guardian call must revert. Does nothing before it.
    function adminCallAfterExpiry(uint256 seed) external {
        if (block.timestamp < expiry) return;
        ledger.setExpected(address(0));
        uint256 which = seed % 6;
        bool ok;
        bytes memory path = abi.encodePacked(address(tokens[1]), uint24(500), address(tokens[0]));
        if (which == 0) {
            vm.prank(admin);
            try router.setAdapter(address(adapter), true) { ok = true; } catch {}
        } else if (which == 1) {
            vm.prank(admin);
            try router.setFeed(address(tokens[1]), address(feeds[0]), 3600, 18) { ok = true; } catch {}
        } else if (which == 2) {
            vm.prank(admin);
            try router.setRoute(address(tokens[1]), path) { ok = true; } catch {}
        } else if (which == 3) {
            vm.prank(admin);
            try router.setGuardian(guardian) { ok = true; } catch {}
        } else if (which == 4) {
            vm.prank(admin);
            try router.setArmingPaused(true) { ok = true; } catch {}
        } else {
            vm.prank(guardian);
            try router.setArmingPaused(true) { ok = true; } catch {}
        }
        if (ok) adminPowerAfterExpiry++;
        else adminRevertedAfterExpiry++;
    }

    function guardianPause(uint256 mode) external {
        ledger.setExpected(address(0));
        vm.prank(guardian);
        try router.setArmingPaused(mode % 4 == 0) {} catch {}
    }

    // ------------------------------------------------------------------ exits and claims

    /// @dev Most calls aim at a position the model says is armed, and a third party mostly names an armed key,
    /// so random sequences reach real exits. The rest stay fully random, to hit the refusals.
    function exitPosition(uint256 who, uint256 oi, uint256 vi, uint256 ki, uint256 amtSeed) external {
        uint256 o = oi % NO;
        uint256 v = vi % NV;
        if (amtSeed % 4 != 0) (o, v) = _pickArmed(oi, o, v);
        uint256 kind = who % 3;
        address caller = kind == 0 ? owners[o] : kind == 1 ? keeper : strangers[who % 2];
        uint256 kIdx = ki % 4; // 3 = no key at all
        if (ki % 8 >= 4 && gMask[o][v] != 0) kIdx = _pickKey(gMask[o][v], ki);
        bytes32 key = kIdx < NK ? keys[kIdx] : bytes32(0);
        uint256 amount = (amtSeed >> 4) % 3 == 0 ? 0 : _b(amtSeed >> 8, 1, 1000e18);

        bytes32 id = _posId(o, v); // computed first: a prank applies to the very next external call
        uint256[NT] memory before = _snapshotFree();
        uint256 owedBefore = _totalOwed();
        bool allowed = caller == owners[o] || _modelAllows(o, v, kIdx); // worked out before the call, from the ghost state only
        ledger.setExpected(owners[o]);
        ledger.clearSwaps();
        vm.prank(caller);
        try router.exit(id, key, amount) {
            if (kind == 0) okOwnerExit++;
            else if (kind == 1) okKeeperExit++;
            else okStrangerExit++;
            if (_totalOwed() > owedBefore) owedBooked++;
            if (caller != owners[o]) _checkThirdParty(o, v, allowed);
            _checkSwaps(o, v, caller != owners[o]);
        } catch (bytes memory err) {
            if (caller != owners[o]) deniedStrangerExit++;
            if (allowed && caller != owners[o] && _isAuthError(err)) alarmModelRefusals++;
        }
        ledger.setExpected(address(0));
        _checkFree(before);
    }

    function _pickArmed(uint256 seed, uint256 o, uint256 v) internal view returns (uint256, uint256) {
        uint256 n;
        for (uint256 i; i < NO * NV; ++i) {
            if (gArmed[i / NV][i % NV]) n++;
        }
        if (n == 0) return (o, v);
        uint256 pick = seed % n;
        for (uint256 i; i < NO * NV; ++i) {
            if (gArmed[i / NV][i % NV]) {
                if (pick == 0) return (i / NV, i % NV);
                pick--;
            }
        }
        return (o, v);
    }

    function _pickKey(uint8 mask, uint256 seed) internal pure returns (uint256) {
        uint256 n;
        for (uint256 k; k < NK; ++k) {
            n += (mask >> k) & 1;
        }
        uint256 pick = seed % n;
        for (uint256 k; k < NK; ++k) {
            if ((mask >> k) & 1 == 1) {
                if (pick == 0) return k;
                pick--;
            }
        }
        return NK;
    }

    /// @dev The model of when a non-owner may exit, written from the rules and the ghost state alone (AlarmBook.isLive is
    /// not used): the position is armed, this key was armed on it, the key fired at or after the arming, and it fired
    /// no more than 24 hours ago.
    function _modelAllows(uint256 o, uint256 v, uint256 kIdx) internal view returns (bool) {
        if (!gArmed[o][v] || kIdx >= NK || ((gMask[o][v] >> kIdx) & 1) == 0) return false;
        uint256 firedAt = gFiredAt[kIdx];
        return firedAt != 0 && firedAt >= gArmedAt[o][v] && block.timestamp <= firedAt + 1 days;
    }

    /// @dev The router's three refusals that are about who may exit: not armed, key not armed, alarm not live.
    function _isAuthError(bytes memory err) internal pure returns (bool) {
        if (err.length < 4) return false;
        bytes4 sel = bytes4(err);
        return sel == ExitRouter.NotArmed.selector || sel == ExitRouter.NotAuthorized.selector || sel == ExitRouter.AlarmNotLive.selector;
    }

    /// @dev A non-owner exit worked, so the model must have allowed it. A position the model says is disarmed is counted separately.
    function _checkThirdParty(uint256 o, uint256 v, bool allowed) internal {
        if (!gArmed[o][v]) disarmedExitByStranger++;
        else if (!allowed) unauthorizedExitByStranger++;
    }

    /// @dev Checks each swap leg of the exit just run against an oracle minimum the handler works out itself from the feeds:
    /// what the pool paid must not be below fair value less the slippage that applies. That slippage is the position's own
    /// limit, and for a non-owner exit at most 1%. The 1 unit allowed is the router's rounding down of its own figure.
    function _checkSwaps(uint256 o, uint256 v, bool thirdParty) internal {
        uint256 n = ledger.swapCount();
        for (uint256 s; s < n; ++s) {
            address tk = ledger.swapToken(s);
            uint256 amountIn = ledger.swapIn(s);
            uint256 paid = (amountIn * swap.outPer1e18()) / 1e18; // stable units the pool gave for it
            uint256 pT;
            if (tk == address(tokens[1])) pT = uint256(feeds[0].answer());
            else if (tk == address(tokens[2])) pT = uint256(feeds[1].answer());
            else {
                swapBelowOracleMin++; // a swap with no feed behind it
                continue;
            }
            uint256 unit = uint256(stableFeed.answer()) * 1e12 * 10_000; // 18-decimal token, 8-decimal feeds, 6-decimal stable
            uint256 slip = gSlip[o][v];
            if (thirdParty && slip > 100) slip = 100;
            swapsChecked++;
            if (paid + 1 < (amountIn * pT * (10_000 - slip)) / unit) swapBelowOracleMin++;
            if (thirdParty) {
                thirdPartySwapsChecked++;
                if (paid + 1 < (amountIn * pT * 9_900) / unit) thirdPartySwapOverSlipCap++;
            }
        }
        ledger.clearSwaps();
    }

    function _pickOwed(uint256 seed, address who, MockERC20 t) internal view returns (address, MockERC20) {
        uint256 n;
        for (uint256 i; i < NO * NT; ++i) {
            if (router.owed(owners[i / NT], address(tokens[i % NT])) > 0) n++;
        }
        if (n == 0) return (who, t);
        uint256 pick = seed % n;
        for (uint256 i; i < NO * NT; ++i) {
            if (router.owed(owners[i / NT], address(tokens[i % NT])) > 0) {
                if (pick == 0) return (owners[i / NT], tokens[i % NT]);
                pick--;
            }
        }
        return (who, t);
    }

    function claimOwed(uint256 oi, uint256 ti, uint256 ci) external {
        bool unknownOwner = oi % 4 == 3;
        address who = unknownOwner ? strangers[oi % 2] : owners[oi % NO];
        MockERC20 t = tokens[ti % NT];
        if (ci % 4 != 0) (who, t) = _pickOwed(ti, who, t); // mostly aim at a real debt
        if (ci % 2 == 0) t.setBlocked(who, false); // the owner fixes their wallet first
        uint256 owedBefore = router.owed(who, address(t));
        uint256[NT] memory before = _snapshotFree();
        ledger.setExpected(who);
        vm.prank(ci % 2 == 0 ? strangers[ci % 2] : keeper);
        try router.claimOwed(who, address(t)) {
            okClaim++;
            if (router.owed(who, address(t)) != 0 || owedBefore == 0) claimPaidSomeoneElse++;
        } catch {}
        ledger.setExpected(address(0));
        _checkFree(before);
    }
}

/// forge-config: default.invariant.runs = 4
/// forge-config: default.invariant.depth = 50
/// forge-config: invariant.invariant.runs = 512
/// forge-config: invariant.invariant.depth = 256
contract RouterInvariants {
    RouterHandler internal h;
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function setUp() public {
        vm.warp(1_800_000_000);
        h = new RouterHandler();
    }

    /// @dev Foundry reads this to decide what to call during an invariant run.
    function targetContracts() public view returns (address[] memory a) {
        a = new address[](1);
        a[0] = address(h);
    }

    function _eq(uint256 a, uint256 b, string memory m) internal pure {
        require(a == b, m);
    }

    // 1. Only the position owner is ever paid.
    function invariant_onlyTheOwnerIsEverPaid() public view {
        Ledger l = h.ledger();
        _eq(l.strangersPaid(), 0, "a transfer out of the router went to someone who is not the position owner");
        _eq(l.badSpender(), 0, "the router's tokens were pulled by something other than the swap router");
    }

    function invariant_nobodyElseHoldsAnyToken() public view {
        for (uint256 t; t < 7; ++t) {
            MockERC20 tok = h.token(t);
            _eq(tok.balanceOf(h.keeper()), 0, "keeper holds tokens");
            _eq(tok.balanceOf(h.strangers(0)), 0, "stranger 0 holds tokens");
            _eq(tok.balanceOf(h.strangers(1)), 0, "stranger 1 holds tokens");
            _eq(tok.balanceOf(address(h.adapter())), 0, "adapter holds tokens");
        }
    }

    // 2. totalOwed = sum of owed, and never more than the router holds.
    function invariant_totalOwedIsTheSumOfOwedAndIsBacked() public view {
        ExitRouter r = h.router();
        for (uint256 t; t < 7; ++t) {
            MockERC20 tok = h.token(t);
            uint256 sum;
            for (uint256 o; o < 3; ++o) {
                sum += r.owed(h.owner(o), address(tok));
            }
            sum += r.owed(h.keeper(), address(tok)) + r.owed(h.strangers(0), address(tok)) + r.owed(h.strangers(1), address(tok));
            _eq(r.totalOwed(address(tok)), sum, "totalOwed != sum of owed");
            require(r.totalOwed(address(tok)) <= tok.balanceOf(address(r)), "owed is more than the router holds");
        }
    }

    // 3. After any exit or claim, nothing is left free in the router beyond what outsiders donated.
    function invariant_noFreeBalanceBeyondDonations() public view {
        ExitRouter r = h.router();
        for (uint256 t; t < 7; ++t) {
            MockERC20 tok = h.token(t);
            _eq(tok.balanceOf(address(r)) - r.totalOwed(address(tok)), h.donated(address(tok)), "free balance is not just donations");
        }
        _eq(h.leftFreeBalance(), 0, "an exit or claim changed the router's free balance");
    }

    // 4. Third parties can exit only armed, live positions.
    function invariant_disarmedPositionsCantBeExitedByAStranger() public view {
        _eq(h.disarmedExitByStranger(), 0, "a non-owner exited a disarmed position");
    }

    function invariant_aStrangerNeedsAnArmedKeyAndALiveAlarm() public view {
        _eq(h.unauthorizedExitByStranger(), 0, "a non-owner exit worked without an armed, live key");
    }

    /// The model of when an alarm may exit someone is the handler's own, and the router agrees with it both ways: it never
    /// allows an exit the model forbids, and never refuses on alarm grounds an exit the model allows.
    function invariant_theRouterAgreesWithTheIndependentAlarmModel() public view {
        _eq(h.alarmModelRefusals(), 0, "the router refused a non-owner exit that the alarm model allows");
        _eq(h.unauthorizedExitByStranger(), 0, "the router allowed a non-owner exit that the alarm model forbids");
    }

    // 5. The admin and the guardian have no power once ADMIN_EXPIRY has passed.
    function invariant_adminAndGuardianCallsRevertAfterExpiry() public view {
        _eq(h.adminPowerAfterExpiry(), 0, "an admin or guardian call worked after ADMIN_EXPIRY");
    }

    // 6. A swap never pays below the oracle minimum, and a third party can never push it past 1%.
    function invariant_aSwapNeverPaysBelowTheOracleMinimum() public view {
        _eq(h.swapBelowOracleMin(), 0, "a swap paid less than the oracle minimum");
    }

    function invariant_aThirdPartyExitNeverSwapsBeyondTheOnePercentCap() public view {
        _eq(h.thirdPartySwapOverSlipCap(), 0, "a third-party exit swapped more than 1% under the oracle");
    }

    function invariant_onlyTheOwnerCanDisarm() public view {
        _eq(h.strangerDisarmed(), 0, "a non-owner disarmed a position");
    }

    function invariant_claimOwedClearsTheNamedOwnersBalance() public view {
        _eq(h.claimPaidSomeoneElse(), 0, "a claim succeeded without clearing the named owner's balance");
    }

    // ------------------------------------------------------------------ scripted proof that the handler reaches the states

    /// @dev Not an invariant. A short fixed sequence showing the handler really arms, pays an owner in kind, books owed,
    /// swaps, lets a keeper exit on a live alarm, refuses a stranger and lets anyone claim for the owner.
    function test_handlerReachesTheInterestingStates() public {
        // owner 0, vault 0 (stablecoin), alarm key 0: keeper exit pays the owner
        h.arm(0, 0, 0, 0, 1);
        h.setPaused(0, true);
        h.poke(0, 0);
        h.exitPosition(1, 0, 0, 0, 0);
        _eq(h.okKeeperExit(), 1, "keeper exit");
        _eq(h.pokesFired(), 1, "alarm fired");

        // a stranger cannot use an unarmed key, and cannot exit a disarmed position
        h.arm(1, 0, 0, 0, 1);
        h.exitPosition(2, 1, 0, 1, 0); // key 1 is not armed on it
        h.disarm(1, 0, false);
        h.exitPosition(2, 1, 0, 0, 0);
        _eq(h.okStrangerExit(), 0, "no stranger exit");
        require(h.deniedStrangerExit() >= 2, "strangers were refused");

        // owner 2 cannot receive the stablecoin: the exit books it as owed, and a claim pays it once unblocked
        h.arm(2, 0, 0, 0, 0);
        h.setBlocked(2, 0, 0); // blocked
        h.exitPosition(0, 2, 0, 3, 0);
        _eq(h.owedBooked(), 1, "owed booked");
        require(h.router().owed(h.owner(2), address(h.token(0))) > 0, "owed to owner 2");
        h.claimOwed(2, 0, 1); // still blocked: refused
        _eq(h.okClaim(), 0, "claim refused while blocked");
        h.setBlocked(2, 0, 2); // unblocked
        h.claimOwed(2, 0, 1);
        _eq(h.okClaim(), 1, "claim paid");

        // a swap: owner 0 arms vault 1 on the stable harbour and exits
        h.arm(0, 1, 1, 1000, 0);
        h.exitPosition(0, 0, 1, 3, 0);
        require(h.ledger().swapPulls() > 0, "the swap leg ran");

        // a partial redeem: shares come back to the owner
        h.arm(1, 2, 0, 0, 0);
        h.setLiquidity(2, 0, 100e18, false);
        h.exitPosition(0, 1, 2, 3, 0);

        // a vault whose asset is its own share token: the shares are both output and leftover, and booked as owed once
        h.arm(0, 3, 0, 0, 0);
        h.setBlocked(0, 6, 0);
        h.exitPosition(0, 0, 3, 3, 0);
        _eq(h.router().owed(h.owner(0), address(h.token(6))), 1000e18, "shares booked as owed exactly once");

        // a keeper's swap: the owner allows 10%, the pool pays 0.5% under the oracle, inside the 1% cap
        _eq(h.swapsChecked(), 1, "one swap checked so far, the owner's");
        h.swapKnobs(95_000, 257); // rate 0.995, pool working, stablecoin on peg
        h.arm(1, 1, 1, 1000, 1); // owner 1, vault 1, stable harbour, 10% limit, alarm key 0 (already fired this second)
        h.exitPosition(1, 1, 1, 0, 0);
        _eq(h.thirdPartySwapsChecked(), 1, "the keeper's swap was checked against the 1% cap");

        // the model and the router agree on the same-second case, where the alarm fired at the second of the arming
        _eq(h.alarmModelRefusals(), 0, "no disagreement");

        invariant_onlyTheOwnerIsEverPaid();
        invariant_totalOwedIsTheSumOfOwedAndIsBacked();
        invariant_noFreeBalanceBeyondDonations();
        invariant_nobodyElseHoldsAnyToken();
        invariant_disarmedPositionsCantBeExitedByAStranger();
        invariant_aStrangerNeedsAnArmedKeyAndALiveAlarm();
        invariant_theRouterAgreesWithTheIndependentAlarmModel();
        invariant_aSwapNeverPaysBelowTheOracleMinimum();
        invariant_aThirdPartyExitNeverSwapsBeyondTheOnePercentCap();
    }

    /// @dev Not an invariant. Before the expiry the handler's admin call does nothing; from the expiry second on, every admin and
    /// guardian call is refused, and the handler counts each refusal.
    function test_adminCallsRevertFromTheExpirySecondOn() public {
        h.adminCallAfterExpiry(0);
        _eq(h.adminRevertedAfterExpiry(), 0, "nothing counted before the expiry");
        h.jumpPastExpiry(0); // lands on the expiry second itself
        for (uint256 i; i < 6; ++i) {
            h.adminCallAfterExpiry(i);
        }
        _eq(h.adminRevertedAfterExpiry(), 6, "six admin and guardian calls, six refusals");
        _eq(h.adminPowerAfterExpiry(), 0, "none worked");
        h.adminSetFeed(0);
        _eq(h.adminRevertedAfterExpiry(), 7, "the feed change was refused too");
        invariant_adminAndGuardianCallsRevertAfterExpiry();
    }
}
