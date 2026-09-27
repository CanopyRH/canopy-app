// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitRouter} from "../src/ExitRouter.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {Timelock} from "../src/Timelock.sol";
import {IAggregatorV3, IERC20} from "../src/interfaces/IExternal.sol";

interface DeployVm {
    function envAddress(string calldata) external view returns (address);
    function envUint(string calldata) external view returns (uint256);
    function envOr(string calldata, bool) external view returns (bool);
    function envOr(string calldata, uint256) external view returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Deploys Canopy v1. Refuses to run on unsafe settings. Admin setup then goes through the Timelock,
/// from multisig batches written by services/deploy/plan.ts. This script makes no admin calls.
/// TIMELOCK_DELAY defaults to 0, so admin changes take effect as soon as the multisig signs them.
contract Deploy {
    DeployVm internal constant vm = DeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bool public IS_SCRIPT = true;
    uint256 public constant BASE_MAINNET = 8453;
    uint256 public constant ROBINHOOD_MAINNET = 4663;
    uint256 public constant MIN_ADMIN_LIFE = 180 days;
    uint256 public constant MAX_ADMIN_LIFE = 730 days;

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
            timelockDelay: vm.envOr("TIMELOCK_DELAY", uint256(0)),
            allowEoaAdmin: vm.envOr("ALLOW_EOA_ADMIN", false)
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
    }

    function isMainnet() public view returns (bool) {
        return block.chainid == BASE_MAINNET || block.chainid == ROBINHOOD_MAINNET;
    }

    function deploy(Config memory c) public returns (Deployed memory d) {
        d.timelock = new Timelock(c.proposer, c.timelockDelay);
        d.book = new AlarmBook(address(d.timelock));
        d.router = new ExitRouter(
            c.stable,
            c.weth,
            c.swapRouter,
            address(d.book),
            address(d.timelock),
            c.guardian,
            c.stableFeed,
            c.heartbeat,
            c.adminExpiry
        );
        d.adapter = new ERC4626Adapter(address(d.router));
    }

    function check(Config memory c, Deployed memory d) public view {
        if (d.timelock.PROPOSER() != c.proposer || d.timelock.DELAY() != c.timelockDelay) revert WiringFailed("timelock");
        if (d.book.ADMIN() != address(d.timelock)) revert WiringFailed("book admin");
        if (d.router.ADMIN() != address(d.timelock)) revert WiringFailed("router admin");
        if (d.router.guardian() != c.guardian) revert WiringFailed("guardian");
        if (address(d.router.ALARMS()) != address(d.book)) revert WiringFailed("alarms");
        if (d.router.ADMIN_EXPIRY() != c.adminExpiry) revert WiringFailed("expiry");
        if (d.router.STABLE() != c.stable) revert WiringFailed("stable");
        if (d.adapter.ROUTER() != address(d.router)) revert WiringFailed("adapter");
        if (d.router.adapterAllowed(address(d.adapter))) revert WiringFailed("adapter must start disabled");
    }
}
