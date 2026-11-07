// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Base} from "./Base.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {CanopyArmPolicy} from "../src/agents/CanopyArmPolicy.sol";
import {MockPausable} from "./Mocks.sol";

contract PolicyAccount {
    address public immutable owner;
    address public executor;

    constructor() {
        owner = msg.sender;
    }

    function install(CanopyArmPolicy module, address agent, uint64 until, bytes32 terms) external {
        require(msg.sender == owner);
        executor = address(module);
        module.onInstall(abi.encode(agent, until, terms));
    }

    function uninstall(CanopyArmPolicy module) external {
        require(msg.sender == owner);
        module.onUninstall("");
        executor = address(0);
    }

    function ownerCall(address target, bytes memory data) external returns (bytes memory) {
        require(msg.sender == owner);
        return call(target, data);
    }

    function executeFromExecutor(bytes32 mode, bytes calldata data) external payable returns (bytes[] memory out) {
        require(msg.sender == executor && mode == bytes32(0) && uint256(bytes32(data[20:52])) == 0);
        out = new bytes[](1);
        out[0] = call(address(bytes20(data[:20])), data[52:]);
    }

    function call(address target, bytes memory data) private returns (bytes memory) {
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        return result;
    }
}

contract CanopyArmPolicyTest is Base {
    CanopyArmPolicy policy;
    PolicyAccount account;
    bytes32 id;
    bytes32 added;
    bytes32 third;

    function setUp() public override {
        super.setUp();
        policy = new CanopyArmPolicy(address(router));
        account = new PolicyAccount();
        account.install(policy, KEEPER, uint64(block.timestamp + 1 days), TERMS);
        id = _setup(address(account), vault, 100e18, 0, 100);
        added = book.register(_detector(AlarmBook.Kind.PAUSED, address(new MockPausable()), 0, 0, 0, 0));
        third = book.register(_detector(AlarmBook.Kind.PAUSED, address(new MockPausable()), 0, 0, 0, 0));
    }

    function params() internal view returns (ExitRouter.ArmParams memory a) {
        bytes32[] memory keys = new bytes32[](2);
        keys[0] = pauseKey;
        keys[1] = added;
        return _params(address(vault), 0, 100, keys);
    }

    function testAgentAddsButCannotRemoveAnyCurrentKey() public {
        ExitRouter.ArmParams memory a = params();
        vm.prank(KEEPER);
        policy.tighten(address(account), a);
        require(router.keysOf(id).length == 2);
        a.keys[1] = third;
        vm.prank(KEEPER);
        vm.expectRevert();
        policy.tighten(address(account), a);
    }

    function testNoOpDuplicateAndLooserPayoutAreRefused() public {
        ExitRouter.ArmParams memory a = params();
        a.maxSlipBps = 101;
        vm.prank(KEEPER);
        vm.expectRevert();
        policy.tighten(address(account), a);
        a = params();
        a.harbour = 1;
        vm.prank(KEEPER);
        vm.expectRevert();
        policy.tighten(address(account), a);
        a = params();
        a.keys[1] = a.keys[0];
        vm.prank(KEEPER);
        vm.expectRevert();
        policy.tighten(address(account), a);
        a = _params(address(vault), 0, 100, _keys(pauseKey));
        vm.prank(KEEPER);
        vm.expectRevert();
        policy.tighten(address(account), a);
    }

    function testAgentExitPaysOnlySmartAccount() public {
        vm.prank(KEEPER);
        policy.exit(address(account), id);
        require(stable.balanceOf(address(account)) == 100e6);
        require(stable.balanceOf(KEEPER) == 0);
    }

    function testUninstallExpiryAndUnapprovedAgentStopExecution() public {
        vm.prank(ATTACKER);
        vm.expectRevert();
        policy.exit(address(account), id);
        account.uninstall(policy);
        vm.prank(KEEPER);
        vm.expectRevert();
        policy.exit(address(account), id);
        account.install(policy, KEEPER, uint64(block.timestamp + 1), TERMS);
        vm.warp(block.timestamp + 1);
        vm.prank(KEEPER);
        vm.expectRevert();
        policy.exit(address(account), id);
    }

    function testOwnerDisarmCannotBeUndoneByAgent() public {
        account.ownerCall(address(router), abi.encodeCall(ExitRouter.disarmAll, ()));
        ExitRouter.ArmParams memory a = params();
        vm.prank(KEEPER);
        vm.expectRevert();
        policy.tighten(address(account), a);
    }

    function testTermsAndSwapLegsCannotBeReplaced() public {
        ExitRouter.ArmParams memory a = params();
        a.termsHash = bytes32(uint256(1));
        vm.prank(KEEPER);
        vm.expectRevert();
        policy.tighten(address(account), a);
        a = params();
        a.swaps = new ExitRouter.SwapLeg[](1);
        a.swaps[0] = _leg(address(weth), address(stableFeed));
        vm.prank(KEEPER);
        vm.expectRevert();
        policy.tighten(address(account), a);
    }

    function testExecutionTimeComparisonSeesInterveningOwnerChange() public {
        ExitRouter.ArmParams memory stale = params();
        ExitRouter.ArmParams memory current = params();
        current.keys[1] = third;
        account.ownerCall(address(router), abi.encodeCall(ExitRouter.arm, (current)));
        vm.prank(KEEPER);
        vm.expectRevert();
        policy.tighten(address(account), stale);
    }

    function testFuzzSlippageNeverIncreases(uint16 proposed) public {
        ExitRouter.ArmParams memory a = params();
        a.maxSlipBps = proposed;
        vm.prank(KEEPER);
        if (proposed > 100) vm.expectRevert();
        policy.tighten(address(account), a);
        (,,,,, uint16 slip,,,,,) = router.positions(id);
        require(slip <= 100);
    }
}
