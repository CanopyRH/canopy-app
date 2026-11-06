// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {AlarmBook} from "../src/AlarmBook.sol";

/// @dev A detector target that answers every reading AlarmBook makes, and can be switched to misbehave:
/// 0 answers, 1 reverts, 2 burns all its gas, 3 returns a single byte, 4 returns a 600 kB payload led by the answer.
contract Chameleon {
    uint8 public mode;
    uint256 public value;

    function set(uint8 m, uint256 v) external {
        mode = m;
        value = v;
    }

    modifier misbehave() {
        uint8 m = mode;
        if (m == 1) revert("no");
        if (m == 2) {
            assembly {
                invalid()
            }
        }
        if (m == 3) {
            assembly {
                mstore(0, 1)
                return(0x1f, 1)
            }
        }
        if (m == 4) {
            uint256 v = value;
            assembly {
                mstore(0, v)
                return(0, 600000)
            }
        }
        _;
    }

    function decimals() external view misbehave returns (uint8) {
        return 18;
    }

    function convertToAssets(uint256) external view misbehave returns (uint256) {
        return value;
    }

    function totalAssets() external view misbehave returns (uint256) {
        return value;
    }

    function curator() external view misbehave returns (address) {
        return address(uint160(value));
    }

    function paused() external view misbehave returns (bool) {
        return value == 1;
    }

    function latestRoundData() external view misbehave returns (uint80, int256, uint256, uint256, uint80) {
        return (1, int256(value), block.timestamp, block.timestamp, 1);
    }
}

/// @notice A2 item 5: every read of a detector's target is capped, and a failed read never fires and is never armable.
/// The one exception is a PAUSED view that reverts outright: the target has no such flag, so it reads "not paused".
contract AlarmReadsTest is Base {
    Chameleon internal c;
    bytes32 internal constant CURATOR = bytes32(bytes4(keccak256("curator()")));

    function setUp() public override {
        super.setUp();
        c = new Chameleon();
        c.set(0, 1e6);
    }

    /// @dev Four detectors on the chameleon, all tripped by a fall from 1e6 to 0.5e6, with DRAIN's reference live.
    function _trippedKeys() internal returns (bytes32[4] memory k) {
        k[0] = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(c), 50, 0, 0, 0));
        k[1] = book.register(_detector(AlarmBook.Kind.DRAIN, address(c), 2500, 1200, 0, 0));
        k[2] = book.register(_detector(AlarmBook.Kind.PRICE_BELOW, address(c), 0.9e6, 3600, 0, 0));
        k[3] = book.register(_detector(AlarmBook.Kind.ADDRESS_CHANGE, address(c), 0, 0, CURATOR, 0));
        vm.warp(block.timestamp + 600);
        book.checkpoint(k[1]); // DRAIN's reference: 1e6
        for (uint256 i; i < 4; ++i) {
            assertTrue(book.armable(k[i]), "clear while healthy");
        }
        c.set(0, 0.5e6);
        for (uint256 i; i < 4; ++i) {
            assertTrue(book.check(k[i]) && !book.armable(k[i]), "tripped when read");
        }
    }

    function _pendingAt(bytes32 k) internal view returns (uint64 p) {
        (,,,,,, p) = book.state(k);
    }

    function test_failedReads_neverFire_andAreNeverArmable() public {
        bytes32[4] memory k = _trippedKeys();
        uint8[3] memory modes = [uint8(1), uint8(2), uint8(3)]; // revert, out of gas, short answer
        for (uint256 m; m < 3; ++m) {
            c.set(modes[m], 0.5e6);
            for (uint256 i; i < 4; ++i) {
                assertTrue(!book.check(k[i]), "a failed read is not tripped");
                assertTrue(!book.armable(k[i]), "and not clear");
                assertTrue(!book.poke(k[i]), "and never fires");
                assertTrue(!book.isLive(k[i], 1 days), "nothing fired");
            }
            assertEq(_pendingAt(k[1]), 0, "no drain confirmation started");
        }
        c.set(0, 0.5e6);
        assertTrue(book.poke(k[0]) && book.poke(k[2]) && book.poke(k[3]), "readable again: they fire");
    }

    function test_pausedViewThatReverts_readsNotPaused_butOneThatBurnsGasIsNotArmable() public {
        bytes32 pk = book.register(_detector(AlarmBook.Kind.PAUSED, address(c), 0, 0, 0, 0));
        c.set(1, 1); // reverts: no pause flag to read
        assertTrue(book.armable(pk) && !book.check(pk) && !book.poke(pk), "a reverting view reads not paused");
        c.set(3, 1); // one byte: not a bool true
        assertTrue(book.armable(pk) && !book.poke(pk), "a short answer reads not paused");
        c.set(2, 1); // burns its whole cap: could be hiding a true
        assertTrue(!book.armable(pk), "out of gas is not armable");
        assertTrue(!book.check(pk) && !book.poke(pk), "and never fires");
        c.set(0, 1);
        assertTrue(!book.armable(pk) && book.poke(pk), "paused: fires");
    }

    function test_gasBurningTarget_costsAtMostTheCap() public {
        bytes32[4] memory k = _trippedKeys();
        c.set(2, 0.5e6);
        uint256 cap = book.TARGET_READ_GAS();
        for (uint256 i; i < 4; ++i) {
            uint256 g0 = gasleft();
            book.poke(k[i]);
            uint256 used = g0 - gasleft();
            assertTrue(used >= cap, "the target burned its cap");
            assertTrue(used < cap + 60_000, "and nothing more than the cap plus AlarmBook's own work");
        }
    }

    function test_returnBombTarget_isNotCopied() public {
        bytes32 ac = book.register(_detector(AlarmBook.Kind.ADDRESS_CHANGE, address(c), 0, 0, CURATOR, 0));
        c.set(4, 1e6); // 600 kB, led by the registered address
        uint256 g0 = gasleft();
        assertTrue(book.armable(ac), "the leading word is read: unchanged");
        uint256 used = g0 - gasleft();
        g0 = gasleft();
        (bool ok, bytes memory ret) = address(c).staticcall(abi.encodeWithSignature("curator()"));
        uint256 naive = g0 - gasleft();
        assertTrue(ok && ret.length == 600000, "a naive call copies all of it");
        assertTrue(used + 300_000 < naive, "AlarmBook pays only the target's own cost, not the copy");
    }

    function test_aDrainConfirmationSurvivesAnUnreadablePoke() public {
        bytes32[4] memory k = _trippedKeys();
        bytes32 dr = k[1];
        assertTrue(!book.poke(dr), "first sight");
        uint64 p = _pendingAt(dr);
        assertTrue(p != 0, "pending");
        c.set(2, 0.5e6);
        vm.warp(block.timestamp + 30);
        assertTrue(!book.poke(dr), "unreadable: no fire");
        assertEq(_pendingAt(dr), p, "and the confirmation is kept, not cancelled");
        c.set(0, 0.5e6);
        vm.warp(block.timestamp + 30);
        assertTrue(book.poke(dr), "seen again a minute after the first sight: fires");
    }
}
