// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Deploy} from "../script/Deploy.s.sol";
import {MockERC20, MockFeed} from "./Mocks.sol";

interface TestVm {
    function warp(uint256) external;
    function chainId(uint256) external;
    function expectRevert(bytes calldata) external;
    function expectRevert(bytes4) external;
    function prank(address) external;
}

contract ContractAdmin {}

contract DeployTest {
    TestVm internal constant vm = TestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    Deploy internal script;
    MockERC20 internal stable;
    MockERC20 internal weth;
    MockFeed internal feed;
    address internal proposer;
    address internal guardian;
    address internal constant EOA = address(0xE0A);

    function setUp() public {
        vm.warp(1_800_000_000);
        script = new Deploy();
        stable = new MockERC20(6);
        weth = new MockERC20(18);
        feed = new MockFeed(1e8);
        proposer = address(new ContractAdmin());
        guardian = address(new ContractAdmin());
    }

    function _watchers() internal pure returns (address[] memory w) {
        w = new address[](3);
        w[0] = address(0x3A1);
        w[1] = address(0x3A2);
        w[2] = address(0x3A3);
    }

    function _cfg() internal view returns (Deploy.Config memory) {
        return Deploy.Config({
            stable: address(stable),
            weth: address(weth),
            swapRouter: address(weth),
            stableFeed: address(feed),
            proposer: proposer,
            guardian: guardian,
            heartbeat: 90_000,
            adminExpiry: block.timestamp + 365 days,
            timelockDelay: 0,
            allowEoaAdmin: false,
            watchers: _watchers()
        });
    }

    function test_validConfigDeploysAndWires() public {
        Deploy.Config memory c = _cfg();
        script.validate(c);
        Deploy.Deployed memory d = script.deploy(c);
        script.check(c, d);
        require(d.router.adapterAllowed(address(d.adapter)), "adapter allowed from the constructor");
        require(d.adapter.ROUTER() == address(d.router), "adapter points at the router it was predicted for");
        for (uint256 i; i < 3; ++i) {
            require(d.book.isWatcher(c.watchers[i]), "watchers active from deployment");
        }
    }

    function test_deployTwiceFromTheSameAccount_predictsEachRouter() public {
        Deploy.Config memory c = _cfg();
        Deploy.Deployed memory d1 = script.deploy(c);
        Deploy.Deployed memory d2 = script.deploy(c);
        script.check(c, d1);
        script.check(c, d2);
        require(address(d1.router) != address(d2.router), "two routers");
        require(d2.adapter.ROUTER() == address(d2.router), "second adapter wired to the second router");
    }

    function test_checkCatchesAnAdapterPointingElsewhere() public {
        Deploy.Config memory c = _cfg();
        Deploy.Deployed memory d1 = script.deploy(c);
        Deploy.Deployed memory d2 = script.deploy(c);
        d1.adapter = d2.adapter;
        vm.expectRevert(abi.encodeWithSelector(Deploy.WiringFailed.selector, "adapter"));
        script.check(c, d1);
    }

    function test_checkCatchesAMissingWatcher() public {
        Deploy.Config memory c = _cfg();
        Deploy.Deployed memory d = script.deploy(c);
        c.watchers[1] = address(0xBAD);
        vm.expectRevert(abi.encodeWithSelector(Deploy.WiringFailed.selector, "watcher not active"));
        script.check(c, d);
    }

    function test_rejectsBadWatcherLists() public {
        Deploy.Config memory c = _cfg();
        c.watchers = new address[](1);
        c.watchers[0] = address(0x3A1);
        vm.expectRevert(Deploy.BadWatchers.selector);
        script.validate(c); // fewer than a quorum needs
        c = _cfg();
        c.watchers[2] = c.watchers[0];
        vm.expectRevert(Deploy.BadWatchers.selector);
        script.validate(c); // a repeat
        c = _cfg();
        c.watchers[1] = address(0);
        vm.expectRevert(Deploy.BadWatchers.selector);
        script.validate(c); // the zero address
        c = _cfg();
        c.watchers[0] = c.proposer;
        vm.expectRevert(Deploy.BadWatchers.selector);
        script.validate(c); // an admin as a watcher
        c = _cfg();
        c.watchers = new address[](17);
        for (uint256 i; i < 17; ++i) {
            c.watchers[i] = address(uint160(0x3B0 + i));
        }
        vm.expectRevert(Deploy.BadWatchers.selector);
        script.validate(c); // more than MAX_WATCHERS
    }

    function test_rejectsPersonalWalletAdminByDefault() public {
        Deploy.Config memory c = _cfg();
        c.proposer = EOA;
        vm.expectRevert(abi.encodeWithSelector(Deploy.AdminMustBeContract.selector, "proposer"));
        script.validate(c);
        c = _cfg();
        c.guardian = EOA;
        vm.expectRevert(abi.encodeWithSelector(Deploy.AdminMustBeContract.selector, "guardian"));
        script.validate(c);
    }

    function test_eoaOverrideNeverWorksOnMainnet() public {
        Deploy.Config memory c = _cfg();
        c.proposer = EOA;
        c.allowEoaAdmin = true;
        script.validate(c); // allowed on a test chain
        vm.chainId(8453);
        vm.expectRevert(abi.encodeWithSelector(Deploy.AdminMustBeContract.selector, "proposer"));
        script.validate(c);
    }

    function test_eoaOverrideNeverWorksOnRobinhood() public {
        Deploy.Config memory c = _cfg();
        c.guardian = EOA;
        c.allowEoaAdmin = true;
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(Deploy.AdminMustBeContract.selector, "guardian"));
        script.validate(c);
    }

    function test_delayIsASetting() public {
        Deploy.Config memory c = _cfg();
        Deploy.Deployed memory d = script.deploy(c);
        require(d.timelock.DELAY() == 0, "no delay by default");
        c.timelockDelay = 6 hours;
        d = script.deploy(c);
        script.check(c, d);
        require(d.timelock.DELAY() == 6 hours, "delay set");
        c.timelockDelay = 0;
        vm.expectRevert(abi.encodeWithSelector(Deploy.WiringFailed.selector, "timelock"));
        script.check(c, d);
    }

    function test_rejectsSameProposerAndGuardian() public {
        Deploy.Config memory c = _cfg();
        c.guardian = c.proposer;
        vm.expectRevert(Deploy.SameAdmin.selector);
        script.validate(c);
    }

    function test_rejectsZeroAdmins() public {
        Deploy.Config memory c = _cfg();
        c.proposer = address(0);
        vm.expectRevert(abi.encodeWithSelector(Deploy.ZeroAddress.selector, "proposer"));
        script.validate(c);
    }

    function test_rejectsMissingContracts() public {
        Deploy.Config memory c = _cfg();
        c.swapRouter = address(0x1234);
        vm.expectRevert(abi.encodeWithSelector(Deploy.NoCode.selector, "swapRouter"));
        script.validate(c);
    }

    function test_rejectsWrongDecimalStable() public {
        Deploy.Config memory c = _cfg();
        c.stable = address(weth);
        vm.expectRevert(Deploy.BadStable.selector);
        script.validate(c);
    }

    function test_rejectsBadOrStaleFeed() public {
        Deploy.Config memory c = _cfg();
        feed.set(0.5e8, block.timestamp);
        vm.expectRevert(Deploy.BadFeed.selector);
        script.validate(c);
        feed.set(1e8, block.timestamp - 90_001);
        vm.expectRevert(Deploy.BadFeed.selector);
        script.validate(c);
    }

    function test_rejectsBadHeartbeat() public {
        Deploy.Config memory c = _cfg();
        c.heartbeat = 0;
        vm.expectRevert(Deploy.BadHeartbeat.selector);
        script.validate(c);
        c.heartbeat = 3 days;
        vm.expectRevert(Deploy.BadHeartbeat.selector);
        script.validate(c);
    }

    function test_rejectsExpiryOutsideRange() public {
        Deploy.Config memory c = _cfg();
        c.adminExpiry = block.timestamp + 30 days;
        vm.expectRevert(Deploy.BadExpiry.selector);
        script.validate(c);
        c.adminExpiry = block.timestamp + 3650 days;
        vm.expectRevert(Deploy.BadExpiry.selector);
        script.validate(c);
    }

    function test_checkCatchesWrongWiring() public {
        Deploy.Config memory c = _cfg();
        Deploy.Deployed memory d = script.deploy(c);
        c.guardian = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(Deploy.WiringFailed.selector, "guardian"));
        script.check(c, d);
    }
}
