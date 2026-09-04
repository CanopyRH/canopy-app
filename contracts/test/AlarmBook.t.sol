// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {Timelock} from "../src/Timelock.sol";
import {MockERC20, MockVault, MockFeed, MockPausable, MockOwned} from "./Mocks.sol";

contract AlarmBookTest is Base {
    uint256 internal constant PK_A = 0xA1;
    uint256 internal constant PK_B = 0xB2;
    uint256 internal constant PK_C = 0xC3;
    address internal wA;
    address internal wB;
    address internal wC;
    bytes32 internal quorumKey;
    bytes32 internal constant EVIDENCE = keccak256("evidence");

    function setUp() public override {
        super.setUp();
        wA = vm.addr(PK_A);
        wB = vm.addr(PK_B);
        wC = vm.addr(PK_C);
        vm.startPrank(ADMIN);
        book.setWatcher(wA, true);
        book.setWatcher(wB, true);
        book.setWatcher(wC, true);
        vm.stopPrank();
        quorumKey = book.register(_detector(AlarmBook.Kind.QUORUM, address(0xBEEF), 2, 0, 0, 0));
    }

    // ---------------------------------------------------------------- on-chain kinds

    function test_priceBelow() public {
        MockFeed f = new MockFeed(1e8);
        bytes32 k = book.register(_detector(AlarmBook.Kind.PRICE_BELOW, address(f), 0.97e8, 3600, 0, 0));
        assertTrue(!book.check(k), "healthy");
        f.set(0.96e8, block.timestamp);
        assertTrue(book.poke(k), "fired");
    }
}
