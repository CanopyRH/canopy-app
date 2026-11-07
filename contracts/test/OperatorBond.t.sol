// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {OperatorBond, WatcherBond, KeeperBond} from "../src/watchnet/OperatorBond.sol";
import {MockERC20} from "./Mocks.sol";

interface BondVm {
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert() external;
}

contract OperatorBondTest {
    BondVm constant vm = BondVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockERC20 token;
    WatcherBond bond;
    address operator;
    address treasury = address(88);
    uint256 constant TEST_KEY = 123;

    function setUp() public {
        vm.warp(36000);
        operator = vm.addr(TEST_KEY);
        token = new MockERC20(18);
        bond = new WatcherBond(address(token), treasury, 100, 40);
        token.mint(operator, 300);
        vm.prank(operator);
        token.approve(address(bond), 300);
        vm.prank(operator);
        bond.deposit(100);
    }

    function statement(bool decision) internal view returns (OperatorBond.Statement memory) {
        return
            OperatorBond.Statement(
                operator, 1, bytes32(uint256(1)), 10, bytes32(uint256(2)), bytes32(uint256(3)), decision
            );
    }

    function signature(OperatorBond.Statement memory s) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 t) = vm.sign(TEST_KEY, bond.digest(s));
        return abi.encodePacked(r, t, v);
    }

    function test_conflictSlashesExactlyOnceAndDeactivatesBelowMinimum() public {
        OperatorBond.Statement memory a = statement(true);
        OperatorBond.Statement memory b = statement(false);
        bytes memory x = signature(a);
        bytes memory y = signature(b);
        require(bond.eligible(operator));
        bond.challenge(a, x, b, y);
        require(token.balanceOf(treasury) == 40 && !bond.eligible(operator));
        vm.expectRevert();
        bond.challenge(a, x, b, y);
    }

    function test_differentEvidenceOrForgedSignatureDoesNotProveFault() public {
        OperatorBond.Statement memory a = statement(true);
        OperatorBond.Statement memory b = statement(false);
        bytes memory x = signature(a);
        b.evidence = bytes32(uint256(7));
        bytes memory y = signature(b);
        vm.expectRevert();
        bond.challenge(a, x, b, y);
        b = statement(false);
        vm.expectRevert();
        bond.challenge(a, x, b, x);
        require(token.balanceOf(treasury) == 0);
    }

    function test_withdrawalLeavesExistingEvidenceChallengeable() public {
        OperatorBond.Statement memory a = statement(true);
        OperatorBond.Statement memory b = statement(false);
        bytes memory x = signature(a);
        bytes memory y = signature(b);
        vm.warp(36100);
        vm.prank(operator);
        bond.requestWithdrawal();
        require(!bond.eligible(operator));
        vm.prank(operator);
        vm.expectRevert();
        bond.withdraw();
        bond.challenge(a, x, b, y);
        vm.warp(36100 + 8 days);
        vm.prank(operator);
        bond.withdraw();
        require(token.balanceOf(operator) == 260);
    }

    function test_newDepositGenerationRejectsOldProof() public {
        OperatorBond.Statement memory a = statement(true);
        OperatorBond.Statement memory b = statement(false);
        bytes memory x = signature(a);
        bytes memory y = signature(b);
        vm.prank(operator);
        bond.requestWithdrawal();
        vm.warp(36000 + 8 days);
        vm.prank(operator);
        bond.withdraw();
        vm.prank(operator);
        bond.deposit(100);
        vm.expectRevert();
        bond.challenge(a, x, b, y);
        (, uint64 generation,,) = bond.stakes(operator);
        require(generation == 2);
    }

    function test_roleAndContractDomainsCannotReplay() public {
        KeeperBond keeper = new KeeperBond(address(token), treasury, 100, 40);
        OperatorBond.Statement memory a = statement(true);
        require(keeper.digest(a) != bond.digest(a));
        WatcherBond other = new WatcherBond(address(token), treasury, 100, 40);
        require(other.digest(a) != bond.digest(a));
    }

    function test_expiredChallengeCannotTakeStake() public {
        OperatorBond.Statement memory a = statement(true);
        OperatorBond.Statement memory b = statement(false);
        bytes memory x = signature(a);
        bytes memory y = signature(b);
        vm.warp(39600 + 7 days);
        vm.expectRevert();
        bond.challenge(a, x, b, y);
        require(bond.eligible(operator));
    }
}
