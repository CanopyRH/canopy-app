// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitRouter} from "../src/ExitRouter.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {Timelock} from "../src/Timelock.sol";
import {IAggregatorV3, IERC20} from "../src/interfaces/IExternal.sol";

interface AdminOwners {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

interface DeployVm {
    function envAddress(string calldata) external view returns (address);
    function envAddress(string calldata, string calldata) external view returns (address[] memory);
    function envUint(string calldata) external view returns (uint256);
    function envOr(string calldata, bool) external view returns (bool);
    function envOr(string calldata, uint256) external view returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
    function getNonce(address) external view returns (uint64);
    function computeCreateAddress(address, uint256) external pure returns (address);
    function readCallers() external returns (uint8 callerMode, address msgSender, address txOrigin);
}

/// @notice Deploys Canopy v2. Refuses to run on unsafe settings, and needs no admin batch afterwards: the watchers
/// (env WATCHERS, a comma-separated list) are active from deployment, and the ERC-4626 adapter is allowed in the
/// router's constructor. The adapter is deployed first, pointing at the router's address predicted from the deployer's
/// nonce, and `check` proves the prediction and every other wiring fact.
/// TIMELOCK_DELAY defaults to seven days; mainnet requires at least seven days and disjoint admin/guardian owners.
contract Deploy {
    DeployVm internal constant vm = DeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bool public IS_SCRIPT = true;
    uint256 public constant BASE_MAINNET = 8453;
    uint256 public constant ROBINHOOD_MAINNET = 4663;
    uint256 public constant MIN_ADMIN_LIFE = 180 days;
    uint256 public constant MAX_ADMIN_LIFE = 730 days;
    uint256 public constant MIN_WATCHERS = 2; // the quorum presets need two signatures
    uint256 public constant MAX_WATCHERS = 16;
    uint8 internal constant CALLER_MODE_BROADCAST = 1;
    uint8 internal constant CALLER_MODE_RECURRENT_BROADCAST = 2;

    struct Config {
        address stable;
        address weth;
        address swapRouter;
        address stableFeed;
        address proposer;
        address guardian;
        uint32 heartbeat;
        uint256 adminExpiry;
        uint256 timelockDelay;
        bool allowEoaAdmin;
        address[] watchers;
    }

    struct Deployed {
        Timelock timelock;
        AlarmBook book;
        ExitRouter router;
        ERC4626Adapter adapter;
    }

    error BadChain();
    error NoCode(string what);
    error SameAdmin();
    error ZeroAddress(string what);
    error AdminMustBeContract(string what);
    error BadExpiry();
    error BadStable();
    error BadFeed();
    error BadHeartbeat();
    error AdminDelayTooShort();
    error SharedAdminOwners();
    error BadAdminThreshold();
    error BadWatchers();
    error WiringFailed(string what);

    function run() external returns (Deployed memory d) {
        Config memory c = Config({
            stable: vm.envAddress("STABLE"),
            weth: vm.envAddress("WETH"),
            swapRouter: vm.envAddress("SWAP_ROUTER"),
            stableFeed: vm.envAddress("STABLE_FEED"),
            proposer: vm.envAddress("PROPOSER_MULTISIG"),
            guardian: vm.envAddress("GUARDIAN_MULTISIG"),
            heartbeat: uint32(vm.envUint("STABLE_FEED_HEARTBEAT")),
            adminExpiry: vm.envUint("ADMIN_EXPIRY"),
            timelockDelay: vm.envOr("TIMELOCK_DELAY", uint256(7 days)),
            allowEoaAdmin: vm.envOr("ALLOW_EOA_ADMIN", false),
            watchers: vm.envAddress("WATCHERS", ",")
        });
        validate(c);
        vm.startBroadcast();
        d = deploy(c);
        vm.stopBroadcast();
        check(c, d);
    }

    function validate(Config memory c) public view {
        if (c.proposer == address(0)) revert ZeroAddress("proposer");
        if (c.guardian == address(0)) revert ZeroAddress("guardian");
        if (c.proposer == c.guardian) revert SameAdmin();
        // Personal wallets as admin are only ever allowed off mainnet.
        bool strict = isMainnet() || !c.allowEoaAdmin;
        if (strict && c.proposer.code.length == 0) revert AdminMustBeContract("proposer");
        if (strict && c.guardian.code.length == 0) revert AdminMustBeContract("guardian");

        if (isMainnet()) {
            if (c.timelockDelay < 7 days) revert AdminDelayTooShort();
            address[] memory a = AdminOwners(c.proposer).getOwners();
            address[] memory g = AdminOwners(c.guardian).getOwners();
            uint256 at = AdminOwners(c.proposer).getThreshold();
            uint256 gt = AdminOwners(c.guardian).getThreshold();
            if (a.length > 32 || g.length > 32 || at < 2 || gt < 2 || at > a.length || gt > g.length) revert BadAdminThreshold();
            for (uint256 i; i < a.length; ++i) {
                if (a[i] == address(0)) revert BadAdminThreshold();
                for (uint256 j; j < i; ++j) {
                    if (a[i] == a[j]) revert BadAdminThreshold();
                }
                for (uint256 j; j < g.length; ++j) {
                    if (a[i] == g[j]) revert SharedAdminOwners();
                }
            }
            for (uint256 i; i < g.length; ++i) {
                if (g[i] == address(0)) revert BadAdminThreshold();
                for (uint256 j; j < i; ++j) {
                    if (g[i] == g[j]) revert BadAdminThreshold();
                }
            }
        }

        if (c.stable.code.length == 0) revert NoCode("stable");
        if (c.weth.code.length == 0) revert NoCode("weth");
        if (c.swapRouter.code.length == 0) revert NoCode("swapRouter");
        if (c.stableFeed.code.length == 0) revert NoCode("stableFeed");
        if (IERC20(c.stable).decimals() != 6) revert BadStable();

        if (c.heartbeat == 0 || c.heartbeat > 2 days) revert BadHeartbeat();
        IAggregatorV3 feed = IAggregatorV3(c.stableFeed);
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (feed.decimals() != 8 || answer < 0.9e8 || answer > 1.1e8) revert BadFeed();
        if (block.timestamp - updatedAt > c.heartbeat) revert BadFeed();

        if (c.adminExpiry < block.timestamp + MIN_ADMIN_LIFE || c.adminExpiry > block.timestamp + MAX_ADMIN_LIFE) {
            revert BadExpiry();
        }

        // Watchers: enough for a quorum, no zero address, no repeats, and none of them an admin.
        uint256 n = c.watchers.length;
        if (n < MIN_WATCHERS || n > MAX_WATCHERS) revert BadWatchers();
        for (uint256 i; i < n; ++i) {
            address w = c.watchers[i];
            if (w == address(0) || w == c.proposer || w == c.guardian) revert BadWatchers();
            for (uint256 j; j < i; ++j) {
                if (c.watchers[j] == w) revert BadWatchers();
            }
        }
    }

    function isMainnet() public view returns (bool) {
        return block.chainid == BASE_MAINNET || block.chainid == ROBINHOOD_MAINNET;
    }

    /// @dev The account the contracts are created from: the broadcaster in a script, this contract in a test.
    function deployer() public returns (address) {
        (uint8 mode, address sender,) = vm.readCallers();
        if (mode == CALLER_MODE_BROADCAST || mode == CALLER_MODE_RECURRENT_BROADCAST) return sender;
        return address(this);
    }

    /// @dev Four creations in a row from one account: Timelock, AlarmBook, the adapter (pointing at the router's predicted
    /// address), then the router, which allows the adapter in its constructor.
    function deploy(Config memory c) public returns (Deployed memory d) {
        validate(c);
        address from = deployer();
        uint256 nonce = vm.getNonce(from);
        address predictedRouter = vm.computeCreateAddress(from, nonce + 3);

        d.timelock = new Timelock(c.proposer, c.timelockDelay);
        d.book = new AlarmBook(address(d.timelock), c.watchers);
        d.adapter = new ERC4626Adapter(predictedRouter);
        address[] memory adapters = new address[](1);
        adapters[0] = address(d.adapter);
        d.router = new ExitRouter(
            c.stable,
            c.weth,
            c.swapRouter,
            address(d.book),
            address(d.timelock),
            c.guardian,
            c.stableFeed,
            c.heartbeat,
            c.adminExpiry,
            adapters
        );
        if (address(d.router) != predictedRouter) revert WiringFailed("router address");
    }

    function check(Config memory c, Deployed memory d) public view {
        if (d.timelock.PROPOSER() != c.proposer || d.timelock.DELAY() != c.timelockDelay) {
            revert WiringFailed("timelock");
        }
        if (d.book.ADMIN() != address(d.timelock)) revert WiringFailed("book admin");
        if (d.router.ADMIN() != address(d.timelock)) revert WiringFailed("router admin");
        if (d.router.guardian() != c.guardian) revert WiringFailed("guardian");
        if (address(d.router.ALARMS()) != address(d.book)) revert WiringFailed("alarms");
        if (d.router.ADMIN_EXPIRY() != c.adminExpiry) revert WiringFailed("expiry");
        if (d.router.STABLE() != c.stable) revert WiringFailed("stable");
        if (d.router.WETH() != c.weth) revert WiringFailed("weth");
        if (d.router.SWAP_ROUTER() != c.swapRouter) revert WiringFailed("swapRouter");
        if (d.router.STABLE_FEED() != c.stableFeed) revert WiringFailed("stableFeed");
        if (d.router.STABLE_FEED_HEARTBEAT() != c.heartbeat) revert WiringFailed("heartbeat");
        if (d.router.armingPaused()) revert WiringFailed("arming paused");
        if (d.adapter.ROUTER() != address(d.router)) revert WiringFailed("adapter");
        if (!d.router.adapterAllowed(address(d.adapter))) revert WiringFailed("adapter not allowed");
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Canopy AlarmBook"),
                keccak256("2"),
                block.chainid,
                address(d.book)
            )
        );
        if (d.book.DOMAIN_SEPARATOR() != domain) revert WiringFailed("domain");
        for (uint256 i; i < c.watchers.length; ++i) {
            address w = c.watchers[i];
            if (!d.book.isWatcher(w)) revert WiringFailed("watcher not active");
            if (d.book.watcherUntil(w) != block.timestamp + d.book.MAX_WATCHER_TERM()) {
                revert WiringFailed("watcher term");
            }
        }
    }
}
