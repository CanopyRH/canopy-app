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
}
