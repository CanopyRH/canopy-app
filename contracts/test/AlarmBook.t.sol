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

    function test_priceBelow_ignoresStaleAnswer() public {
        MockFeed f = new MockFeed(1e8);
        bytes32 k = book.register(_detector(AlarmBook.Kind.PRICE_BELOW, address(f), 0.97e8, 3600, 0, 0));
        f.set(0.96e8, block.timestamp - 3601);
        assertTrue(!book.check(k), "stale does not fire");
    }

    function test_shareDrop_andHighWaterMark() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
        vault.setPrice(1.1e6);
        book.checkpoint(k);
        vault.setPrice(1.0950e6); // 0.45% below the new mark
        assertTrue(!book.check(k), "inside threshold");
        vault.setPrice(1.09e6);
        assertTrue(book.poke(k), "fired against the raised mark");
    }

    function test_shareDrop_markNeverFalls() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
        vault.setPrice(0.9e6);
        book.checkpoint(k);
        assertTrue(book.check(k), "cannot be reset away");
    }

    function test_shareDrop_smallDipDoesNotLowerMark() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
        vault.setPrice(0.999e6); // 0.1% down: not tripped, so checkpoint runs
        book.checkpoint(k);
        vault.setPrice(0.9945e6); // 0.55% below the original mark, only 0.45% below a lowered one
        assertTrue(book.check(k), "measured against the original mark");
    }

    function test_drain_snapshotCannotResetAfterWindowWhileTripped() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.DRAIN, address(vault), 2500, 3600, 0, 0));
        vm.warp(block.timestamp + 1800); // past window/2, so only the tripped check protects it
        vault.setPrice(0.74e6);
        book.checkpoint(k);
        assertTrue(book.check(k), "a drain cannot be reset away");
    }

    function test_paused() public {
        assertTrue(!book.check(pauseKey), "not paused");
        pausable.setPaused(true);
        assertTrue(book.poke(pauseKey), "fired");
    }

    function test_addressChange() public {
        MockOwned o = new MockOwned(OWNER);
        bytes32 k = book.register(
            _detector(AlarmBook.Kind.ADDRESS_CHANGE, address(o), 0, 0, bytes32(bytes4(keccak256("curator()"))), 0)
        );
        assertTrue(!book.check(k), "unchanged");
        o.setCurator(KEEPER);
        assertTrue(book.poke(k), "fired");
    }

    function test_drain_andCheckpointRules() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.DRAIN, address(vault), 2500, 3600, 0, 0));
        vault.setPrice(0.74e6); // totalAssets down 26%
        assertTrue(!book.check(k), "a new detector has no confirmed baseline yet");
        vault.setPrice(1e6);
        vm.warp(block.timestamp + 1800);
        book.checkpoint(k); // the first period's low becomes the baseline
        vault.setPrice(0.74e6);
        assertTrue(book.check(k), "tripped");
        vm.warp(block.timestamp + 1800);
        book.checkpoint(k);
        assertTrue(book.check(k), "snapshot does not refresh while tripped");
        assertTrue(book.poke(k), "fired");
    }

    function test_drain_snapshotExpires() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k = book.register(_detector(AlarmBook.Kind.DRAIN, address(vault), 2500, 3600, 0, 0));
        vm.warp(block.timestamp + 1800);
        book.checkpoint(k);
        vm.warp(block.timestamp + 3601);
        vault.setPrice(0.5e6);
        assertTrue(!book.check(k), "old snapshot does not count");
    }
}
