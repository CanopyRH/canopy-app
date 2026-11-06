// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721, IV3SwapRouter, IWETH} from "./interfaces/IExternal.sol";
import {IExitAdapter} from "./interfaces/IExitAdapter.sol";
import {IAlarmBook, IAlarmBookDetector} from "./interfaces/IAlarmBook.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {FullMath} from "./lib/FullMath.sol";
import {CappedCall} from "./lib/CappedCall.sol";

/// @title ExitRouter
/// @notice Pulls a user's DeFi position back to the user's own wallet. That is all it can do.
///
/// Hard rules enforced here (not in any prompt, bot or service):
/// 1. Funds go to the position owner and nowhere else. `exit` has no recipient parameter; every
///    outbound transfer in this contract is addressed to `p.owner` (or WETH, when wrapping ETH).
/// 2. Who may call `exit`: the owner, or anyone at all while an alarm the owner armed for that
///    position is live in AlarmBook. A rogue keeper can therefore, at worst, exit the owner early.
/// 3. Exits are never gated: no pause, fee, plan check or oracle can block `exit`. The optional swap
///    is skipped whenever the oracle is stale or unreadable, the stablecoin is off its peg, the owner
///    chose no swap for that token, or the pool cannot fill at the oracle-bounded minimum.
/// 4. The owner can revoke instantly: `disarm`, `disarmAll`, or revoking the token approval.
/// 5. Admin (a Timelock; its delay is a deploy setting) can only allow or disallow adapters and replace the guardian,
///    and only until ADMIN_EXPIRY. It has no swap settings: the owner names every swap leg (token, feed, route) when
///    arming. Disabling an adapter never affects positions already armed. The guardian can only pause NEW arming.
///    Nobody can upgrade this contract.
contract ExitRouter is ReentrancyGuard {
    using SafeTransferLib for address;

    /// @notice Harbour: deliver what the unwind produced.
    uint8 public constant HARBOUR_RAW = 0;
    /// @notice Harbour: swap each output the owner named a leg for into STABLE, when the oracle allows.
    uint8 public constant HARBOUR_STABLE = 1;
    /// @notice 10% ceiling on the owner's own slippage setting.
    uint16 public constant MAX_SLIP_CAP_BPS = 1000;
    /// @notice Largest token decimals a swap leg may state.
    uint8 public constant MAX_TOKEN_DECIMALS = 36;
    /// @notice 1% ceiling on slippage when anyone but the owner runs the exit.
    uint16 public constant THIRD_PARTY_SLIP_CAP_BPS = 100;
    /// @notice How long after a fire a third party may exit.
    uint256 public constant ALARM_TTL = 1 days;
    /// @notice Most alarm keys per position.
    uint256 public constant MAX_KEYS = 8;
    /// @notice Most swap legs per position.
    uint256 public constant MAX_SWAPS = 4;
    /// @notice Longest staleness limit a swap leg's feed may have.
    uint32 public constant MAX_FEED_HEARTBEAT = 2 days;
    /// @notice Never swap INTO the stablecoin below $0.985.
    uint256 public constant STABLE_FLOOR_BPS = 9850;
    /// @notice Gas given to each price-feed read (`latestRoundData`, `decimals`).
    uint256 public constant FEED_READ_GAS = 100_000;
    /// @notice Gas given to the whole oracle quote of one swap leg (four feed reads and the arithmetic).
    uint256 public constant QUOTE_GAS = 4 * FEED_READ_GAS + 100_000;
    uint8 internal constant STABLE_DECIMALS = 6;
    uint8 internal constant KIND_DRAIN = 4; // AlarmBook.Kind.DRAIN
    uint8 internal constant KIND_QUORUM = 5; // AlarmBook.Kind.QUORUM
    uint8 internal constant KIND_BOTH = 6; // AlarmBook.Kind.BOTH

    /// @notice The 6-decimal stablecoin every swap ends in.
    address public immutable STABLE;
    /// @notice WETH, used when an owner can't take native ETH (address(0): none).
    address public immutable WETH;
    /// @notice Uniswap SwapRouter02.
    address public immutable SWAP_ROUTER;
    /// @notice The AlarmBook that decides when third parties may exit.
    IAlarmBook public immutable ALARMS;
    /// @notice The admin (a Timelock; its delay is a deploy setting).
    address public immutable ADMIN;
    /// @notice When the admin and guardian lose every power.
    uint256 public immutable ADMIN_EXPIRY;
    /// @notice USD price feed of STABLE (8-decimal Chainlink-style).
    address public immutable STABLE_FEED;
    /// @notice Staleness limit for STABLE_FEED.
    uint32 public immutable STABLE_FEED_HEARTBEAT;

    /// @notice One owner-chosen swap: `token` is swapped along `path` (Uniswap v3, token -> ... -> STABLE), with the
    /// minimum set from `feed` (USD per token, stale after `heartbeat` s) for a token of `tokenDecimals` decimals.
    struct SwapLeg {
        address token;
        address feed;
        uint32 heartbeat;
        uint8 tokenDecimals;
        bytes path;
    }

    struct Position {
        address owner;
        uint64 armedAt;
        uint64 epoch;
        bool active;
        uint8 harbour;
        uint16 maxSlipBps;
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
        SwapLeg[] swaps;
    }

    /// @notice The account that may pause new arming, besides the admin.
    address public guardian;
    /// @notice Whether new arming is paused (has no effect from ADMIN_EXPIRY on).
    bool public armingPaused;

    /// @notice Adapters new positions may use.
    mapping(address => bool) public adapterAllowed;
    /// @notice Positions by id.
    mapping(bytes32 => Position) public positions;
    mapping(bytes32 => bytes32[]) internal _keys;
    mapping(bytes32 => SwapLeg[]) internal _swaps;
    /// @notice Whether a key is armed on a position.
    mapping(bytes32 => mapping(bytes32 => bool)) public keyArmed;
    /// @notice Each owner's disarmAll counter; a position armed under an older epoch is off.
    mapping(address => uint64) public epochOf;

    /// @notice Tokens the owner could not receive at exit time. Claimable by or for the owner only.
    mapping(address => mapping(address => uint256)) public owed;
    /// @notice Sum of `owed` per token.
    mapping(address => uint256) public totalOwed;

    /// @notice Number of exits so far (the last exit id).
    uint256 public exitCount;

    /// @notice A position was armed (or re-armed, replacing its keys and swap legs).
    /// @param posId The position.
    /// @param owner The owner, who sent the arming.
    /// @param adapter The adapter.
    /// @param target The protocol target (vault).
    /// @param tokenId The NFT id, 0 for ERC-20 positions.
    /// @param harbour HARBOUR_RAW or HARBOUR_STABLE.
    /// @param maxSlipBps The owner's slippage limit for its own exits.
    /// @param termsHash The hash of the terms the owner accepted.
    /// @param keys The armed alarm keys.
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
    /// @notice One swap leg of the position armed just before (one event per leg, after Armed).
    /// @param posId The position.
    /// @param token The token the leg swaps.
    /// @param feed The token's USD feed.
    /// @param heartbeat The feed's staleness limit, in seconds.
    /// @param tokenDecimals The token's decimals.
    /// @param path The Uniswap v3 path, token to STABLE.
    event SwapLegSet(
        bytes32 indexed posId, address indexed token, address feed, uint32 heartbeat, uint8 tokenDecimals, bytes path
    );
    /// @notice A position was disarmed.
    /// @param posId The position.
    /// @param owner Its owner.
    event Disarmed(bytes32 indexed posId, address indexed owner);
    /// @notice Every position of `owner` was disarmed.
    /// @param owner The owner.
    /// @param newEpoch The owner's new epoch.
    event DisarmedAll(address indexed owner, uint64 newEpoch);
    /// @notice A position was exited.
    /// @param exitId The exit's id.
    /// @param posId The position.
    /// @param owner The owner, who was paid.
    /// @param caller Who sent the exit.
    /// @param alarmKey The key named by the caller.
    /// @param viaAlarm True when a third party exited on a live alarm.
    event Exited(
        uint256 indexed exitId, bytes32 indexed posId, address indexed owner, address caller, bytes32 alarmKey, bool viaAlarm
    );
    /// @notice A payout reached the owner.
    /// @param exitId The exit's id.
    /// @param owner The owner.
    /// @param token The token paid (WETH when native ETH was refused).
    /// @param amount The amount.
    /// @param swapped True for STABLE paid on the stable harbour.
    event Paid(uint256 indexed exitId, address indexed owner, address token, uint256 amount, bool swapped);
    /// @notice A swap leg the owner chose did not run, so the raw token was delivered.
    /// @param token The token.
    /// @param amount The amount that was not swapped.
    event SwapSkipped(address indexed token, uint256 amount);
    /// @notice A payout the owner could not receive was booked as owed.
    /// @param owner The owner.
    /// @param token The token.
    /// @param amount The amount booked.
    event Owed(address indexed owner, address indexed token, uint256 amount);
    /// @notice An owed balance was paid to its owner.
    /// @param owner The owner.
    /// @param token The token.
    /// @param amount The amount paid.
    event OwedClaimed(address indexed owner, address indexed token, uint256 amount);
    /// @notice An adapter was allowed or disallowed for new positions.
    /// @param adapter The adapter.
    /// @param allowed Whether new positions may use it.
    event AdapterSet(address indexed adapter, bool allowed);
    /// @notice The guardian changed.
    /// @param guardian The new guardian.
    event GuardianSet(address guardian);
    /// @notice New arming was paused or unpaused.
    /// @param paused Whether new arming is paused.
    event ArmingPaused(bool paused);

    /// @notice The caller is not the admin, or the admin has expired.
    error NotAdmin();
    /// @notice The caller is neither guardian nor admin, or they have expired.
    error NotGuardian();
    /// @notice New arming is paused.
    error ArmingIsPaused();
    /// @notice The adapter is not allowed.
    error NotSupported();
    /// @notice The harbour is neither RAW nor STABLE.
    error BadHarbour();
    /// @notice The slippage limit is above MAX_SLIP_CAP_BPS.
    error SlipTooHigh();
    /// @notice More than MAX_KEYS keys.
    error TooManyKeys();
    /// @notice The caller does not own the position (or the NFT).
    error NotOwner();
    /// @notice A token id was given for an ERC-20 position.
    error BadTokenId();
    /// @notice A third party tried to exit a position that is not armed.
    error NotArmed();
    /// @notice A third party named a key that is not armed on this position.
    error NotAuthorized();
    /// @notice The named key did not fire at or after the arming, within ALARM_TTL.
    error AlarmNotLive();
    /// @notice The owner holds or has approved nothing to exit.
    error NothingToExit();
    /// @notice The unwind produced nothing.
    error NothingWithdrawn();
    /// @notice The NFT adapter did not return the NFT.
    error NftNotReturned();
    /// @notice A swap leg's path is malformed, doesn't start at its token, or doesn't end at STABLE.
    error BadRoute();
    /// @notice A swap leg's feed has no code, its heartbeat is 0 or above MAX_FEED_HEARTBEAT, or its decimals are above
    /// MAX_TOKEN_DECIMALS or differ from the token's own `decimals()`.
    error BadFeed();
    /// @notice Nothing is owed to this owner in this token.
    error NothingOwed();
    /// @notice A key is not armable now: unknown, tripped, unreadable, or fired within the last day.
    /// @param key The key.
    error AlarmNotClear(bytes32 key);
    /// @notice Swap legs were given with the RAW harbour.
    error SwapsNeedStableHarbour();
    /// @notice More than MAX_SWAPS swap legs.
    error TooManySwaps();
    /// @notice Two swap legs name the same token.
    /// @param token The token.
    error DuplicateSwap(address token);
    /// @notice A DRAIN key can't be armed except as a part of a BOTH key whose other part is a QUORUM key: DRAIN trusts
    /// the vault's own readings, so it must never exit anyone without watcher signatures.
    /// @param key The armed key that carries a DRAIN without a QUORUM: a bare DRAIN key, or such a BOTH key.
    error DrainNeedsQuorum(bytes32 key);
    /// @notice A BOTH key whose part is itself a BOTH key can't be armed, so the check of a BOTH key's parts is complete.
    /// @param key The BOTH key.
    error NestedBoth(bytes32 key);

    /// @param stable The 6-decimal stablecoin.
    /// @param weth WETH, or address(0).
    /// @param swapRouter Uniswap SwapRouter02.
    /// @param alarms The AlarmBook.
    /// @param admin The admin (a Timelock).
    /// @param guardian_ The first guardian.
    /// @param stableFeed STABLE's USD feed.
    /// @param stableFeedHeartbeat Staleness limit for that feed.
    /// @param adminExpiry When the admin and guardian lose every power.
    /// @param initialAdapters Adapters allowed from the start.
    constructor(
        address stable,
        address weth,
        address swapRouter,
        address alarms,
        address admin,
        address guardian_,
        address stableFeed,
        uint32 stableFeedHeartbeat,
        uint256 adminExpiry,
        address[] memory initialAdapters
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
        for (uint256 i; i < initialAdapters.length; ++i) {
            adapterAllowed[initialAdapters[i]] = true;
            emit AdapterSet(initialAdapters[i], true);
        }
    }

    /// @notice Accepts native ETH from an adapter during an unwind.
    receive() external payable {}

    // ------------------------------------------------------------------ owner actions

    /// @notice Arm a position. The caller is always the owner: nobody can arm on someone else's behalf. Re-arming replaces
    /// the keys and swap legs. Every key must be armable in AlarmBook now (clear, readable, not fired in the last day). A
    /// DRAIN key counts only as a part of a BOTH key whose other part is a QUORUM key: a bare DRAIN key, or a BOTH key with
    /// a DRAIN part and a non-QUORUM other part, reverts DrainNeedsQuorum, and a BOTH key with a BOTH part reverts
    /// NestedBoth. These checks read only AlarmBook's stored detectors.
    /// @param a The position, keys and swap legs.
    /// @return posId The position id.
    function arm(ArmParams calldata a) external returns (bytes32 posId) {
        if (armingPaused && block.timestamp < ADMIN_EXPIRY) revert ArmingIsPaused();
        if (!adapterAllowed[a.adapter]) revert NotSupported();
        if (a.harbour > HARBOUR_STABLE) revert BadHarbour();
        if (a.maxSlipBps > MAX_SLIP_CAP_BPS) revert SlipTooHigh();
        if (a.keys.length > MAX_KEYS) revert TooManyKeys();
        _validateSwaps(a.harbour, a.swaps);
        for (uint256 i; i < a.keys.length; ++i) {
            bytes32 k = a.keys[i];
            _checkDrainHasQuorum(k);
            if (!ALARMS.armable(k)) revert AlarmNotClear(k);
        }

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
        delete _swaps[posId];
        for (uint256 i; i < a.swaps.length; ++i) {
            _swaps[posId].push(a.swaps[i]);
        }

        positions[posId] = Position({
            owner: msg.sender,
            armedAt: uint64(block.timestamp),
            epoch: epochOf[msg.sender],
            active: true,
            harbour: a.harbour,
            maxSlipBps: a.maxSlipBps,
            adapter: a.adapter,
            target: a.target,
            asset: asset,
            isNft: isNft,
            tokenId: a.tokenId
        });

        emit Armed(posId, msg.sender, a.adapter, a.target, a.tokenId, a.harbour, a.maxSlipBps, a.termsHash, a.keys);
        for (uint256 i; i < a.swaps.length; ++i) {
            SwapLeg calldata l = a.swaps[i];
            emit SwapLegSet(posId, l.token, l.feed, l.heartbeat, l.tokenDecimals, l.path);
        }
    }

    /// @notice Disarm one of the caller's positions. Only third-party exits stop; the owner can still exit.
    /// @param posId The position.
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

    /// @notice Exit a position to its owner. There is deliberately no recipient parameter. The owner may always exit; anyone
    /// else needs an armed key that fired at or after the arming (the arming's own second counts) and within ALARM_TTL.
    /// The sender chooses the gas: too little for the optional swap makes the swap skip and the raw token is paid.
    /// @param posId The position.
    /// @param alarmKey The armed key that fired (ignored for the owner).
    /// @param amount ERC-20 shares to exit (0 = everything the owner holds and has approved). Ignored for NFTs.
    /// @return exitId The id of this exit.
    function exit(bytes32 posId, bytes32 alarmKey, uint256 amount) external nonReentrant returns (uint256 exitId) {
        Position memory p = positions[posId];
        bool viaAlarm = _authorize(p, posId, alarmKey);
        // Read before any external call, like the position: nothing a callback writes can change this exit's swaps.
        SwapLeg[] memory legs = _swaps[posId];

        exitId = ++exitCount;
        if (!_unwindAndPay(exitId, p, legs, amount, viaAlarm)) revert NothingWithdrawn();

        emit Exited(exitId, posId, p.owner, msg.sender, alarmKey, viaAlarm);
    }

    /// @notice Pay out anything the owner could not receive at exit time. Anyone may trigger it; it only pays the owner.
    /// @param owner The owner named in the owed record.
    /// @param token The token (address(0) for native ETH).
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

    /// @notice The id of a position.
    /// @param owner The owner.
    /// @param adapter The adapter.
    /// @param target The protocol target (vault).
    /// @param tokenId The NFT id, 0 for ERC-20 positions.
    /// @return The id.
    function positionId(address owner, address adapter, address target, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, adapter, target, tokenId));
    }

    /// @notice The keys armed on a position.
    /// @param posId The position.
    /// @return The keys.
    function keysOf(bytes32 posId) external view returns (bytes32[] memory) {
        return _keys[posId];
    }

    /// @notice The swap legs armed on a position.
    /// @param posId The position.
    /// @return The legs.
    function swapsOf(bytes32 posId) external view returns (SwapLeg[] memory) {
        return _swaps[posId];
    }

    /// @notice Whether third parties can currently exit a position on a live armed alarm.
    /// @param posId The position.
    /// @return True if active and not revoked by disarmAll.
    function isArmed(bytes32 posId) external view returns (bool) {
        Position storage p = positions[posId];
        return p.active && p.epoch == epochOf[p.owner];
    }

    /// @notice Oracle-bounded minimum stablecoin out for `amount` of a token priced by `feed`. ok=false means "do not swap".
    /// Each feed read gets at most FEED_READ_GAS. For a position, use the feed, heartbeat and decimals of its leg
    /// (`swapsOf`).
    /// @param feed The token's USD feed.
    /// @param heartbeat The token feed's staleness limit, in seconds.
    /// @param tokenDecimals The token's decimals.
    /// @param amount Token units to price.
    /// @param slipBps The slippage allowed under fair value.
    /// @return ok Whether the swap may run.
    /// @return minOut The least STABLE the swap must return.
    function quoteMinOut(address feed, uint32 heartbeat, uint8 tokenDecimals, uint256 amount, uint16 slipBps)
        public
        view
        returns (bool ok, uint256 minOut)
    {
        if (feed == address(0) || slipBps > MAX_SLIP_CAP_BPS || tokenDecimals > MAX_TOKEN_DECIMALS) return (false, 0);
        (bool okT, uint256 pT, uint8 dT) = _price(feed, heartbeat);
        if (!okT) return (false, 0);
        (bool okU, uint256 pU, uint8 dU) = _price(STABLE_FEED, STABLE_FEED_HEARTBEAT);
        if (!okU) return (false, 0);
        if (pU * 10_000 < STABLE_FLOOR_BPS * 10 ** dU) return (false, 0);
        uint256 usdScaled = FullMath.mulDiv(amount, pT, 10 ** dT); // USD x 10^tokenDecimals
        uint256 fair = FullMath.mulDiv(usdScaled, 10 ** (uint256(dU) + STABLE_DECIMALS), pU * 10 ** tokenDecimals);
        minOut = (fair * (10_000 - slipBps)) / 10_000;
        ok = minOut > 0;
    }

    // ------------------------------------------------------------------ admin (Timelock) / guardian

    modifier onlyAdmin() {
        if (msg.sender != ADMIN || block.timestamp >= ADMIN_EXPIRY) revert NotAdmin();
        _;
    }

    /// @notice Allow or disallow an adapter for new positions. Disallowing never affects positions already armed.
    /// @param adapter The adapter.
    /// @param allowed Whether new positions may use it.
    function setAdapter(address adapter, bool allowed) external onlyAdmin {
        adapterAllowed[adapter] = allowed;
        emit AdapterSet(adapter, allowed);
    }

    /// @notice Replace the guardian.
    /// @param g The new guardian.
    function setGuardian(address g) external onlyAdmin {
        guardian = g;
        emit GuardianSet(g);
    }

    /// @notice Guardian or admin can pause NEW arming only, until ADMIN_EXPIRY. Exits, disarming and claims are unaffected.
    /// @param paused Whether new arming is paused.
    function setArmingPaused(bool paused) external {
        if (block.timestamp >= ADMIN_EXPIRY) revert NotGuardian();
        if (msg.sender != guardian && msg.sender != ADMIN) revert NotGuardian();
        armingPaused = paused;
        emit ArmingPaused(paused);
    }

    // ------------------------------------------------------------------ internals

    /// @dev Legs only with the STABLE harbour, at most MAX_SWAPS, one per token, each with a feed that has code, a heartbeat
    /// in (0, MAX_FEED_HEARTBEAT], the token's own decimals (read with a FEED_READ_GAS cap), and a well-formed Uniswap v3
    /// path from the token to STABLE.
    function _validateSwaps(uint8 harbour, SwapLeg[] calldata swaps) internal view {
        if (swaps.length == 0) return;
        if (harbour != HARBOUR_STABLE) revert SwapsNeedStableHarbour();
        if (swaps.length > MAX_SWAPS) revert TooManySwaps();
        for (uint256 i; i < swaps.length; ++i) {
            SwapLeg calldata l = swaps[i];
            for (uint256 j; j < i; ++j) {
                if (swaps[j].token == l.token) revert DuplicateSwap(l.token);
            }
            if (l.feed.code.length == 0 || l.heartbeat == 0 || l.heartbeat > MAX_FEED_HEARTBEAT) revert BadFeed();
            if (l.tokenDecimals > MAX_TOKEN_DECIMALS) revert BadFeed();
            // The stated decimals set the oracle minimum, so they must be the token's own: a leg that claimed more would
            // shrink the minimum by a power of ten and let a third party swap at almost any price.
            (bool okD, uint256[5] memory dec) =
                CappedCall.readWords(l.token, abi.encodeWithSelector(0x313ce567), FEED_READ_GAS, 1); // decimals()
            if (!okD || dec[0] != l.tokenDecimals) revert BadFeed();
            bytes calldata path = l.path;
            if (path.length < 43 || (path.length - 20) % 23 != 0) revert BadRoute();
            if (address(bytes20(path[0:20])) != l.token) revert BadRoute();
            if (address(bytes20(path[path.length - 20:])) != STABLE) revert BadRoute();
        }
    }

    /// @dev The owner can always exit, armed or not. A third party needs an armed key that fired at or after this arming.
    function _authorize(Position memory p, bytes32 posId, bytes32 alarmKey) internal view returns (bool viaAlarm) {
        if (msg.sender == p.owner) return false;
        if (!p.active || p.epoch != epochOf[p.owner]) revert NotArmed();
        if (!keyArmed[posId][alarmKey]) revert NotAuthorized();
        uint256 sinceArmed = block.timestamp - p.armedAt;
        if (!ALARMS.isLive(alarmKey, sinceArmed < ALARM_TTL ? sinceArmed : ALARM_TTL)) revert AlarmNotLive();
        return true;
    }

    /// @dev Pulls the position into its adapter, unwinds it, and pays every output to the owner. Returns whether anything
    /// was delivered.
    function _unwindAndPay(uint256 exitId, Position memory p, SwapLeg[] memory legs, uint256 amount, bool viaAlarm)
        internal
        returns (bool delivered)
    {
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

        delivered = _settle(exitId, legs, p, outs, before, viaAlarm);

        uint256 stableOut = _free(STABLE) - stableBefore;
        if (stableOut > 0) {
            _pay(exitId, p.owner, STABLE, stableOut, p.harbour == HARBOUR_STABLE);
            delivered = true;
        }
    }

    /// @dev A DRAIN may reach an exit only through BOTH(DRAIN, QUORUM). BOTH parts can't be BOTH keys, so one level of
    /// parts is the whole tree. Reads AlarmBook's stored detectors only (no call to any target).
    function _checkDrainHasQuorum(bytes32 k) internal view {
        (uint8 kind,,,, bytes32 pa, bytes32 pb) = IAlarmBookDetector(address(ALARMS)).detector(k);
        if (kind == KIND_DRAIN) revert DrainNeedsQuorum(k);
        if (kind != KIND_BOTH) return;
        (uint8 ka,,,,,) = IAlarmBookDetector(address(ALARMS)).detector(pa);
        (uint8 kb,,,,,) = IAlarmBookDetector(address(ALARMS)).detector(pb);
        if (ka == KIND_BOTH || kb == KIND_BOTH) revert NestedBoth(k);
        if ((ka == KIND_DRAIN && kb != KIND_QUORUM) || (kb == KIND_DRAIN && ka != KIND_QUORUM)) revert DrainNeedsQuorum(k);
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

    function _settle(
        uint256 exitId,
        SwapLeg[] memory legs,
        Position memory p,
        address[] memory outs,
        uint256[] memory before,
        bool viaAlarm
    ) internal returns (bool delivered) {
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
            if (p.harbour == HARBOUR_STABLE && t != address(0) && _swapIfLeg(legs, t, d, slip)) {
                nowFree = _free(t);
                d = nowFree > before[i] ? nowFree - before[i] : 0;
            }
            if (d > 0) {
                _pay(exitId, p.owner, t, d, false);
                delivered = true;
            }
        }
    }

    /// @dev Runs the owner's swap leg for `token`, if the position has one. No leg: no swap, the raw token is paid.
    function _swapIfLeg(SwapLeg[] memory legs, address token, uint256 amount, uint16 slipBps) internal returns (bool) {
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].token == token) return _trySwap(token, amount, slipBps, legs[i]);
        }
        return false;
    }

    /// @dev Optional leg. Any failure (stale, missing or gas-burning feed, stablecoin off peg, pool below the oracle bound,
    /// token refusing approval) returns false and the raw token is delivered instead.
    function _trySwap(address token, uint256 amount, uint16 slipBps, SwapLeg memory leg) internal returns (bool swapped) {
        // An external call, because try can't catch an overflow in the pricing. Capped, so a hostile feed costs bounded gas.
        (bool called, bytes memory ret) = address(this).staticcall{gas: QUOTE_GAS}(
            abi.encodeCall(this.quoteMinOut, (leg.feed, leg.heartbeat, leg.tokenDecimals, amount, slipBps))
        );
        (bool ok, uint256 minOut) = called && ret.length == 64 ? abi.decode(ret, (bool, uint256)) : (false, 0);
        if (!ok || !token.tryApprove(SWAP_ROUTER, amount)) {
            emit SwapSkipped(token, amount);
            return false;
        }
        try IV3SwapRouter(SWAP_ROUTER).exactInput(
            IV3SwapRouter.ExactInputParams({path: leg.path, recipient: address(this), amountIn: amount, amountOutMinimum: minOut})
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

    /// @dev Reads a feed with at most FEED_READ_GAS per call. Any failure, short answer or stale price is "no price".
    function _price(address feed, uint32 heartbeat) internal view returns (bool ok, uint256 price, uint8 dec) {
        (bool okR, uint256[5] memory r) = CappedCall.readWords(feed, abi.encodeWithSelector(0xfeaf968c), FEED_READ_GAS, 5);
        if (!okR) return (false, 0, 0);
        int256 answer = int256(r[1]);
        uint256 updatedAt = r[3];
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (false, 0, 0);
        if (block.timestamp - updatedAt > heartbeat) return (false, 0, 0);
        (bool okD, uint256[5] memory dd) = CappedCall.readWords(feed, abi.encodeWithSelector(0x313ce567), FEED_READ_GAS, 1);
        if (!okD || dd[0] > 30) return (false, 0, 0);
        return (true, uint256(answer), uint8(dd[0]));
    }
}
