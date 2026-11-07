// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {PerpsArmBook} from "../src/perps/PerpsArmBook.sol";
import {GuardBook} from "./BorrowGuard.t.sol";

interface PerpsVm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert() external;
}

contract PerpsArmBookTest {
    PerpsVm constant vm = PerpsVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    GuardBook book;
    PerpsArmBook arms;
    address constant EXECUTOR = address(0xB0B);
    bytes32 constant KEY = bytes32(uint256(1));

    function setUp() public {
        vm.warp(1000);
        book = new GuardBook();
        arms = new PerpsArmBook(address(book));
    }

    function args() internal view returns (PerpsArmBook.Arm memory a) {
        a = PerpsArmBook.Arm(
            EXECUTOR,
            address(book),
            keccak256("lighter-rh"),
            keccak256("23"),
            keccak256("BTC"),
            keccak256("terms"),
            1000,
            2000,
            60,
            5000,
            100,
            new bytes32[](1)
        );
        a.keys[0] = KEY;
    }

    function test_ownerScopedIdentityAndRevisionPreventRearmRace() public {
        bytes32 id = arms.arm(args());
        book.set(true);
        require(arms.executable(id, 1, KEY));
        vm.prank(EXECUTOR);
        vm.expectRevert();
        arms.disarm(id);
        arms.disarm(id);
        require(!arms.executable(id, 1, KEY));
        arms.arm(args());
        require(!arms.executable(id, 1, KEY));
        require(arms.executable(id, 3, KEY));
    }

    function test_capExpiryKeysAndExecutorAreEnforced() public {
        bytes32 id = arms.arm(args());
        vm.prank(EXECUTOR);
        vm.expectRevert();
        arms.recordClose(id, 1, KEY, keccak256("fill"), 1, 1000);
        book.set(true);
        vm.expectRevert();
        arms.recordClose(id, 1, KEY, keccak256("fill"), 1, 1000);
        vm.prank(EXECUTOR);
        vm.expectRevert();
        arms.recordClose(id, 1, KEY, keccak256("fill"), 1001, 1000);
        vm.prank(EXECUTOR);
        vm.expectRevert();
        arms.recordClose(id, 1, KEY, keccak256("fill"), 1, 1001);
        vm.prank(EXECUTOR);
        vm.expectRevert();
        arms.recordClose(id, 1, bytes32(uint256(2)), keccak256("fill"), 1, 1000);
        vm.warp(2000);
        require(!arms.executable(id, 1, KEY));
    }

    function test_partialFillAndReplay() public {
        bytes32 id = arms.arm(args());
        book.set(true);
        vm.prank(EXECUTOR);
        arms.recordClose(id, 1, KEY, keccak256("fill"), 400, 1000);
        require(arms.policy(id).remainingSize == 600);
        vm.prank(EXECUTOR);
        vm.expectRevert();
        arms.recordClose(id, 1, KEY, keccak256("fill"), 400, 1000);
        vm.prank(EXECUTOR);
        arms.recordClose(id, 1, KEY, keccak256("fill2"), 600, 1000);
        require(!arms.policy(id).active);
    }

    function testFuzz_receiptsNeverExceedBudget(uint256 n) public {
        n = n % 1000 + 1;
        bytes32 id = arms.arm(args());
        book.set(true);
        vm.prank(EXECUTOR);
        arms.recordClose(id, 1, KEY, keccak256("fill"), n, 1000);
        require(arms.policy(id).remainingSize == 1000 - n);
    }

    function test_invalidAndDuplicateAlarmsRejected() public {
        PerpsArmBook.Arm memory a = args();
        a.keys = new bytes32[](2);
        a.keys[0] = KEY;
        a.keys[1] = KEY;
        vm.expectRevert();
        arms.arm(a);
        a = args();
        a.maxSlippageBps = 101;
        vm.expectRevert();
        arms.arm(a);
        a = args();
        a.referenceFeed = address(4);
        vm.expectRevert();
        arms.arm(a);
    }
}
