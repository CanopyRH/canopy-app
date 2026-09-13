// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, IERC721, IAggregatorV3, IV3SwapRouter, IWETH} from "./interfaces/IExternal.sol";
import {IExitAdapter} from "./interfaces/IExitAdapter.sol";
import {IAlarmBook} from "./interfaces/IAlarmBook.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {FullMath} from "./lib/FullMath.sol";

/// @title ExitRouter
/// @notice Pulls a user's DeFi position back to the user's own wallet. That is all it can do.
///
/// Hard rules enforced here (not in any prompt, bot or service):
/// 1. Funds go to the position owner and nowhere else. `exit` has no recipient parameter; every
///    outbound transfer in this contract is addressed to `p.owner` (or WETH, when wrapping ETH).
/// 2. Who may call `exit`: the owner, or anyone at all while an alarm the owner armed for that
///    position is live in AlarmBook. A rogue keeper can therefore, at worst, exit the owner early.
/// 3. Exits are never gated: no pause, fee, plan check or oracle can block `exit`. The optional swap
///    is skipped whenever the oracle is stale, the stablecoin is off its peg, no route is set, or the
///    pool cannot fill at the oracle-bounded minimum.
/// 4. The owner can revoke instantly: `disarm`, `disarmAll`, or revoking the token approval.
/// 5. Admin (a Timelock, delay set at deploy) can only set adapters, feeds and swap routes, and only until ADMIN_EXPIRY.
///    Disabling an adapter never affects positions already armed. The guardian can only pause NEW
///    arming. Nobody can upgrade this contract.
contract ExitRouter is ReentrancyGuard {
    using SafeTransferLib for address;

    uint8 public constant HARBOUR_RAW = 0;
    uint8 public constant HARBOUR_STABLE = 1;
    uint16 public constant MAX_SLIP_CAP_BPS = 1000; // 10% ceiling for the owner's own exits
    uint8 public constant MAX_TOKEN_DECIMALS = 36;
    uint16 public constant THIRD_PARTY_SLIP_CAP_BPS = 100; // 1% ceiling when anyone else runs the exit
    uint256 public constant ALARM_TTL = 1 days;
    uint256 public constant MAX_KEYS = 8;
    uint256 public constant STABLE_FLOOR_BPS = 9850; // never swap INTO the stablecoin below $0.985
    uint8 internal constant STABLE_DECIMALS = 6;

    address public immutable STABLE;
    address public immutable WETH;
    address public immutable SWAP_ROUTER;
    IAlarmBook public immutable ALARMS;
    address public immutable ADMIN; // Timelock (48h)
    uint256 public immutable ADMIN_EXPIRY;
    address public immutable STABLE_FEED;
    uint32 public immutable STABLE_FEED_HEARTBEAT;

    struct Feed {
        address feed;
        uint32 heartbeat;
        uint8 tokenDecimals;
    }

    struct Position {
        address owner;
        uint64 armedAt;
        uint64 epoch;
        bool active;
        uint8 harbour;
        uint16 maxSlipBps;
        uint64 swapConfig; // swap settings the owner armed under
        address adapter;
        address target;
        address asset;
        bool isNft;
        uint256 tokenId;
    }

    struct ArmParams {
        address adapter;
        address target;
        uint256 tokenId;
        uint8 harbour;
        uint16 maxSlipBps;
        bytes32 termsHash;
        bytes32[] keys;
    }

    address public guardian;
    bool public armingPaused;
    uint64 public swapConfig; // rises with every feed or route change

    mapping(address => bool) public adapterAllowed;
    mapping(address => Feed) public feeds;
    mapping(address => bytes) public routes;
    mapping(bytes32 => Position) public positions;
    mapping(bytes32 => bytes32[]) internal _keys;
    mapping(bytes32 => mapping(bytes32 => bool)) public keyArmed;
    mapping(address => uint64) public epochOf;

    /// @notice Tokens the owner could not receive at exit time. Claimable by or for the owner only.
    mapping(address => mapping(address => uint256)) public owed;
    mapping(address => uint256) public totalOwed;

    uint256 public exitCount;

    event Armed(
        bytes32 indexed posId,
        address indexed owner,
        address adapter,
        address target,
        uint256 tokenId,
        uint8 harbour,
        uint16 maxSlipBps,
        bytes32 termsHash,
        bytes32[] keys
    );
    event Disarmed(bytes32 indexed posId, address indexed owner);
    event DisarmedAll(address indexed owner, uint64 newEpoch);
    event Exited(
        uint256 indexed exitId, bytes32 indexed posId, address indexed owner, address caller, bytes32 alarmKey, bool viaAlarm
    );
    event Paid(uint256 indexed exitId, address indexed owner, address token, uint256 amount, bool swapped);
    event SwapSkipped(address indexed token, uint256 amount);
    event Owed(address indexed owner, address indexed token, uint256 amount);
    event OwedClaimed(address indexed owner, address indexed token, uint256 amount);
    event AdapterSet(address indexed adapter, bool allowed);
    event FeedSet(address indexed token, address feed, uint32 heartbeat, uint8 tokenDecimals);
    event RouteSet(address indexed token, bytes path);
    event GuardianSet(address guardian);
    event ArmingPaused(bool paused);

    error NotAdmin();
    error NotGuardian();
    error ArmingIsPaused();
    error NotSupported();
    error BadHarbour();
    error SlipTooHigh();
    error TooManyKeys();
    error NotOwner();
    error BadTokenId();
    error NotArmed();
    error NotAuthorized();
    error AlarmNotLive();
    error NothingToExit();
    error NothingWithdrawn();
    error NftNotReturned();
    error BadRoute();
    error BadFeed();
    error NothingOwed();

    constructor(
        address stable,
        address weth,
        address swapRouter,
        address alarms,
        address admin,
        address guardian_,
        address stableFeed,
        uint32 stableFeedHeartbeat,
        uint256 adminExpiry
    ) {
        STABLE = stable;
        WETH = weth;
        SWAP_ROUTER = swapRouter;
        ALARMS = IAlarmBook(alarms);
        ADMIN = admin;
        guardian = guardian_;
        STABLE_FEED = stableFeed;
        STABLE_FEED_HEARTBEAT = stableFeedHeartbeat;
        ADMIN_EXPIRY = adminExpiry;
    }

    receive() external payable {} // native ETH from a future adapter during an unwind

    // ------------------------------------------------------------------ owner actions

    /// @notice Arm a position. The caller is always the owner: nobody can arm on someone else's behalf.
    function arm(ArmParams calldata a) external returns (bytes32 posId) {
        if (armingPaused && block.timestamp < ADMIN_EXPIRY) revert ArmingIsPaused();
        if (!adapterAllowed[a.adapter]) revert NotSupported();
        if (a.harbour > HARBOUR_STABLE) revert BadHarbour();
        if (a.maxSlipBps > MAX_SLIP_CAP_BPS) revert SlipTooHigh();
        if (a.keys.length > MAX_KEYS) revert TooManyKeys();

        (address asset, bool isNft) = IExitAdapter(a.adapter).positionAsset(a.target);
        if (isNft) {
            if (IERC721(asset).ownerOf(a.tokenId) != msg.sender) revert NotOwner();
        } else if (a.tokenId != 0) {
            revert BadTokenId();
        }

        posId = positionId(msg.sender, a.adapter, a.target, a.tokenId);
        bytes32[] storage old = _keys[posId];
        for (uint256 i; i < old.length; ++i) {
            keyArmed[posId][old[i]] = false;
        }
        delete _keys[posId];
        for (uint256 i; i < a.keys.length; ++i) {
            keyArmed[posId][a.keys[i]] = true;
            _keys[posId].push(a.keys[i]);
        }

        positions[posId] = Position({
            owner: msg.sender,
            armedAt: uint64(block.timestamp),
            epoch: epochOf[msg.sender],
            active: true,
            harbour: a.harbour,
            maxSlipBps: a.maxSlipBps,
            swapConfig: swapConfig,
            adapter: a.adapter,
            target: a.target,
            asset: asset,
            isNft: isNft,
            tokenId: a.tokenId
        });

        emit Armed(posId, msg.sender, a.adapter, a.target, a.tokenId, a.harbour, a.maxSlipBps, a.termsHash, a.keys);
    }

    function disarm(bytes32 posId) external {
        if (positions[posId].owner != msg.sender) revert NotOwner();
        positions[posId].active = false;
        emit Disarmed(posId, msg.sender);
    }

    /// @notice One-tap revoke: every position of the caller stops working immediately.
    function disarmAll() external {
        uint64 e = ++epochOf[msg.sender];
        emit DisarmedAll(msg.sender, e);
    }

    // ------------------------------------------------------------------ exit

    /// @notice Exit a position to its owner. There is deliberately no recipient parameter.
    /// @param amount ERC-20 shares to exit (0 = everything the owner holds and has approved). Ignored for NFTs.
    function exit(bytes32 posId, bytes32 alarmKey, uint256 amount) external nonReentrant returns (uint256 exitId) {
        Position memory p = positions[posId];
        bool viaAlarm = _authorize(p, posId, alarmKey);

        exitId = ++exitCount;
        uint256 amountOrId = _pull(p, amount);

        address[] memory outs = _outputList(p, amountOrId);
        uint256[] memory before = new uint256[](outs.length);
        for (uint256 i; i < outs.length; ++i) {
            before[i] = _free(outs[i]);
        }
        uint256 stableBefore = _free(STABLE);

        IExitAdapter(p.adapter).unwind(p.target, amountOrId);

        if (p.isNft) {
            if (IERC721(p.asset).ownerOf(p.tokenId) != address(this)) revert NftNotReturned();
            IERC721(p.asset).transferFrom(address(this), p.owner, p.tokenId);
        }

        bool delivered = _settle(exitId, p, outs, before, viaAlarm);

        uint256 stableOut = _free(STABLE) - stableBefore;
        if (stableOut > 0) {
            _pay(exitId, p.owner, STABLE, stableOut, p.harbour == HARBOUR_STABLE);
            delivered = true;
        }
        if (!delivered) revert NothingWithdrawn();

        emit Exited(exitId, posId, p.owner, msg.sender, alarmKey, viaAlarm);
    }

    /// @notice Pay out anything the owner could not receive at exit time. Anyone may trigger it; it only pays the owner.
    function claimOwed(address owner, address token) external nonReentrant {
        uint256 amt = owed[owner][token];
        if (amt == 0) revert NothingOwed();
        owed[owner][token] = 0;
        totalOwed[token] -= amt;
        if (token == address(0)) {
            (bool ok,) = owner.call{value: amt}("");
            if (!ok) revert NothingOwed();
        } else {
            token.safeTransfer(owner, amt);
        }
        emit OwedClaimed(owner, token, amt);
    }

    // ------------------------------------------------------------------ views

    function positionId(address owner, address adapter, address target, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, adapter, target, tokenId));
    }

    function keysOf(bytes32 posId) external view returns (bytes32[] memory) {
        return _keys[posId];
    }

    function isArmed(bytes32 posId) external view returns (bool) {
        Position storage p = positions[posId];
        return p.active && p.epoch == epochOf[p.owner];
    }

    /// @notice Oracle-bounded minimum stablecoin out for `amount` of `token`. ok=false means "do not swap".
    function quoteMinOut(address token, uint256 amount, uint16 slipBps) public view returns (bool ok, uint256 minOut) {
        Feed memory f = feeds[token];
        if (f.feed == address(0) || slipBps > MAX_SLIP_CAP_BPS) return (false, 0);
        (bool okT, uint256 pT, uint8 dT) = _price(f.feed, f.heartbeat);
        (bool okU, uint256 pU, uint8 dU) = _price(STABLE_FEED, STABLE_FEED_HEARTBEAT);
        if (!okT || !okU) return (false, 0);
        if (pU * 10_000 < STABLE_FLOOR_BPS * 10 ** dU) return (false, 0);
        uint256 usdScaled = FullMath.mulDiv(amount, pT, 10 ** dT); // USD x 10^tokenDecimals
        uint256 fair = FullMath.mulDiv(usdScaled, 10 ** (uint256(dU) + STABLE_DECIMALS), pU * 10 ** f.tokenDecimals);
        minOut = (fair * (10_000 - slipBps)) / 10_000;
        ok = minOut > 0;
    }

    // ------------------------------------------------------------------ admin (Timelock) / guardian

    modifier onlyAdmin() {
        if (msg.sender != ADMIN || block.timestamp >= ADMIN_EXPIRY) revert NotAdmin();
        _;
    }

    /// @notice Disabling an adapter only stops new arming. Existing positions keep working.
    function setAdapter(address adapter, bool allowed) external onlyAdmin {
        adapterAllowed[adapter] = allowed;
        emit AdapterSet(adapter, allowed);
    }

    /// @notice Feed and route changes reach a position only when its owner re-arms. Until then it delivers raw.
    function setFeed(address token, address feed, uint32 heartbeat, uint8 tokenDecimals) external onlyAdmin {
        if ((feed != address(0) && feed.code.length == 0) || tokenDecimals > MAX_TOKEN_DECIMALS) revert BadFeed();
        ++swapConfig;
        feeds[token] = Feed(feed, heartbeat, tokenDecimals);
        emit FeedSet(token, feed, heartbeat, tokenDecimals);
    }

    /// @notice Uniswap v3 path token -> ... -> STABLE. Validated so a route can only ever end in STABLE.
    function setRoute(address token, bytes calldata path) external onlyAdmin {
        if (path.length != 0) {
            if (path.length < 43 || (path.length - 20) % 23 != 0) revert BadRoute();
            if (address(bytes20(path[0:20])) != token) revert BadRoute();
            if (address(bytes20(path[path.length - 20:])) != STABLE) revert BadRoute();
        }
        ++swapConfig;
        routes[token] = path;
        emit RouteSet(token, path);
    }

    function setGuardian(address g) external onlyAdmin {
        guardian = g;
        emit GuardianSet(g);
    }

    /// @notice Guardian can pause NEW arming only, until ADMIN_EXPIRY. Exits, disarming and claims are unaffected.
    function setArmingPaused(bool paused) external {
        if (block.timestamp >= ADMIN_EXPIRY) revert NotGuardian();
        if (msg.sender != guardian && msg.sender != ADMIN) revert NotGuardian();
        armingPaused = paused;
        emit ArmingPaused(paused);
    }

    // ------------------------------------------------------------------ internals

    /// @dev The owner can always exit, armed or not. A third party needs an armed key that fired after this arming.
    function _authorize(Position memory p, bytes32 posId, bytes32 alarmKey) internal view returns (bool viaAlarm) {
        if (msg.sender == p.owner) return false;
        if (!p.active || p.epoch != epochOf[p.owner]) revert NotArmed();
        if (!keyArmed[posId][alarmKey]) revert NotAuthorized();
        uint256 sinceArmed = block.timestamp - p.armedAt;
        if (!ALARMS.isLive(alarmKey, sinceArmed < ALARM_TTL ? sinceArmed : ALARM_TTL)) revert AlarmNotLive();
        return true;
    }

    /// @dev The only `from` ever used is the position owner; the only `to` is the owner's chosen adapter.
    function _pull(Position memory p, uint256 amount) internal returns (uint256) {
        if (p.isNft) {
            IERC721(p.asset).transferFrom(p.owner, p.adapter, p.tokenId);
            return p.tokenId;
        }
        uint256 bal = p.asset.balanceOf(p.owner);
        uint256 al = SafeTransferLib.allowance(p.asset, p.owner, address(this));
        uint256 amt = bal < al ? bal : al;
        if (amount != 0 && amount < amt) amt = amount;
        if (amt == 0) revert NothingToExit();
        p.asset.safeTransferFrom(p.owner, p.adapter, amt);
        return amt;
    }

    function _outputList(Position memory p, uint256 amountOrId) internal view returns (address[] memory list) {
        address[] memory outs = IExitAdapter(p.adapter).outputs(p.target, amountOrId);
        uint256 extra = p.isNft ? 0 : 1;
        list = new address[](outs.length + extra);
        for (uint256 i; i < outs.length; ++i) {
            list[i] = outs[i];
        }
        if (extra == 1) list[outs.length] = p.asset; // leftover shares go back to the owner
    }

    /// @dev Balance minus what is already owed to someone: deltas of this value are what the exit produced.
    function _free(address token) internal view returns (uint256) {
        uint256 bal = token == address(0) ? address(this).balance : token.balanceOf(address(this));
        uint256 o = totalOwed[token];
        return bal > o ? bal - o : 0;
    }

    function _settle(uint256 exitId, Position memory p, address[] memory outs, uint256[] memory before, bool viaAlarm)
        internal
        returns (bool delivered)
    {
        uint16 slip = viaAlarm && p.maxSlipBps > THIRD_PARTY_SLIP_CAP_BPS ? THIRD_PARTY_SLIP_CAP_BPS : p.maxSlipBps;
        for (uint256 i; i < outs.length; ++i) {
            address t = outs[i];
            if (t == STABLE) continue; // paid once, after the loop (swap proceeds included)
            uint256 nowFree = _free(t);
            if (nowFree <= before[i]) continue;
            uint256 d = nowFree - before[i];
            if (!p.isNft && t == p.asset) {
                _pay(exitId, p.owner, t, d, false); // unredeemed shares back to the owner
                continue;
            }
            if (p.harbour == HARBOUR_STABLE && t != address(0)) {
                if (p.swapConfig != swapConfig) {
                    emit SwapSkipped(t, d);
                } else if (_trySwap(t, d, slip)) {
                    nowFree = _free(t);
                    d = nowFree > before[i] ? nowFree - before[i] : 0;
                }
            }
            if (d > 0) {
                _pay(exitId, p.owner, t, d, false);
                delivered = true;
            }
        }
    }

    /// @dev Optional leg. Any failure (no route, stale or missing feed, stablecoin off peg, pool below the
    /// oracle bound, token refusing approval) returns false and the raw token is delivered instead.
    function _trySwap(address token, uint256 amount, uint16 slipBps) internal returns (bool swapped) {
        bytes memory path = routes[token];
        // An external call, because try can't catch a feed with no code or an overflow in the pricing.
        (bool called, bytes memory ret) = address(this).staticcall(abi.encodeCall(this.quoteMinOut, (token, amount, slipBps)));
        (bool ok, uint256 minOut) = called && ret.length == 64 ? abi.decode(ret, (bool, uint256)) : (false, 0);
        if (path.length == 0 || !ok) {
            emit SwapSkipped(token, amount);
            return false;
        }
        if (!token.tryApprove(SWAP_ROUTER, amount)) {
            emit SwapSkipped(token, amount);
            return false;
        }
        try IV3SwapRouter(SWAP_ROUTER).exactInput(
            IV3SwapRouter.ExactInputParams({
                path: path,
                recipient: address(this),
                amountIn: amount,
                amountOutMinimum: minOut
            })
        ) returns (uint256) {
            swapped = true;
        } catch {
            emit SwapSkipped(token, amount);
        }
        token.tryApprove(SWAP_ROUTER, 0);
    }

    function _pay(uint256 exitId, address owner, address token, uint256 amount, bool swapped) internal {
        bool ok;
        if (token == address(0)) {
            (ok,) = owner.call{value: amount}("");
            if (!ok && WETH != address(0)) {
                // Owner cannot take ETH: deliver WETH instead.
                try IWETH(WETH).deposit{value: amount}() {
                    ok = WETH.tryTransfer(owner, amount);
                    if (!ok) {
                        owed[owner][WETH] += amount;
                        totalOwed[WETH] += amount;
                        emit Owed(owner, WETH, amount);
                        return;
                    }
                    emit Paid(exitId, owner, WETH, amount, false);
                    return;
                } catch {}
            }
        } else {
            ok = token.tryTransfer(owner, amount);
        }
        if (ok) {
            emit Paid(exitId, owner, token, amount, swapped);
        } else {
            owed[owner][token] += amount;
            totalOwed[token] += amount;
            emit Owed(owner, token, amount);
        }
    }

    function _price(address feed, uint32 heartbeat) internal view returns (bool ok, uint256 price, uint8 dec) {
        try IAggregatorV3(feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (false, 0, 0);
            if (block.timestamp - updatedAt > heartbeat) return (false, 0, 0);
            price = uint256(answer);
        } catch {
            return (false, 0, 0);
        }
        try IAggregatorV3(feed).decimals() returns (uint8 d) {
            if (d > 30) return (false, 0, 0);
            dec = d;
        } catch {
            return (false, 0, 0);
        }
        ok = true;
    }
}
