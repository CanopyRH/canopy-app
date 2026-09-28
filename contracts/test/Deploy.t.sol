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
            allowEoaAdmin: false
        });
    }

    function test_validConfigDeploysAndWires() public {
        Deploy.Config memory c = _cfg();
        script.validate(c);
        Deploy.Deployed memory d = script.deploy(c);
        script.check(c, d);
        require(!d.router.adapterAllowed(address(d.adapter)), "adapter starts disabled");
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
}
