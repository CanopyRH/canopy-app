// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ExitRouter} from "../src/ExitRouter.sol";

/// @dev Your own alarm levels. The app lets a user pick how far a vault's share price must fall before their "Vault
/// loss" alarm exits them: 0.5%, 1%, 2%, 5% or 10%. Each level is a plain SHARE_DROP detector, so nothing in the
/// contracts changed: registration is open, the key is the hash of the detector, and a poke fires it like any other.
/// These tests show a level registers, fires at exactly its threshold, exits only the position that armed it, and that
/// the app and the contracts agree on every key.
contract AlarmLevelsTest is Base {
    uint8 internal constant RAW = 0;
    uint256 internal constant ONE = 1e6; // the mock vault's starting price: 1 share = 1 USD, in 6-decimal units

    /// @dev What services/src/api/levels.ts works out for the vault at address 0xa1. The app computes these in the browser.
    bytes32 internal constant KEY_050 = 0x84f4dce8ed924d647e512e672afe1e47a1f105835ca9fe67b93d8559a81ea06a;
    bytes32 internal constant KEY_100 = 0xb6aff78865f81b8cd7322ec7b5df76c257e365c46d3a74ff1e95f73bce5cae3d;
    bytes32 internal constant KEY_200 = 0x2abbf22a211c2fd82e8c6c4d50c0af6d64ffe4e0a835718ae15a740be2829dbb;
    bytes32 internal constant KEY_500 = 0x093b229c333e41f4291fcd109d5dd03d85bce6e87d54008fa9149a63b9c87bd6;
    bytes32 internal constant KEY_1000 = 0x3c8d401d8db337ea7a94fad4aacb28f5adc65b39a437b958bd7f862c9d5cb411;

    function _level(address v, uint256 bps) internal pure returns (AlarmBook.Detector memory) {
        return _detector(AlarmBook.Kind.SHARE_DROP, v, bps, 0, 0, 0);
    }

    function _levels() internal pure returns (uint256[5] memory) {
        return [uint256(50), 100, 200, 500, 1000];
    }

    /// @dev The price that is exactly `bps` under the starting price. A price at this value does not fire; one unit lower does.
    function _edge(uint256 bps) internal pure returns (uint256) {
        return (ONE * (10_000 - bps)) / 10_000;
    }

    function test_levelKeysAreTheOnesTheAppWorksOut() public view {
        address v = address(0xa1);
        assertTrue(book.keyOf(_level(v, 50)) == KEY_050, "0.5%");
        assertTrue(book.keyOf(_level(v, 100)) == KEY_100, "1%");
        assertTrue(book.keyOf(_level(v, 200)) == KEY_200, "2%");
        assertTrue(book.keyOf(_level(v, 500)) == KEY_500, "5%");
        assertTrue(book.keyOf(_level(v, 1000)) == KEY_1000, "10%");
    }

    function test_anyoneCanRegisterALevel_andRegisteringAgainChangesNothing() public {
        vault.deposit(OWNER, 100e18);
        uint256[5] memory levels = _levels();
        for (uint256 i; i < levels.length; ++i) {
            AlarmBook.Detector memory d = _level(address(vault), levels[i]);
            vm.prank(ATTACKER);
            bytes32 key = book.register(d);
            assertTrue(key == book.keyOf(d), "the key is the hash of the detector");
            (bool exists,,, uint256 baseline,,,,) = book.state(key);
            assertTrue(exists, "registered");
            assertEq(baseline, ONE, "the high-water mark starts at the current price");
            vm.prank(OWNER);
            assertTrue(book.register(d) == key, "same key for the next caller");
        }
    }

    function test_everyLevelFiresAtItsOwnThresholdAndNotBefore() public {
        vault.deposit(OWNER, 100e18);
        uint256[5] memory levels = _levels();
        for (uint256 i; i < levels.length; ++i) {
            bytes32 key = book.register(_level(address(vault), levels[i]));
            vault.setPrice(_edge(levels[i]));
            assertTrue(!book.check(key), "exactly at the level is not a loss yet");
            vault.setPrice(_edge(levels[i]) - 1);
            assertTrue(book.check(key), "one unit past the level fires");
            vault.setPrice(ONE);
        }
    }

    function test_aSmallerLevelFiresSooner_aBiggerOneWaits() public {
        vault.deposit(OWNER, 100e18);
        bytes32 k050 = book.register(_level(address(vault), 50));
        bytes32 k200 = book.register(_level(address(vault), 200));
        bytes32 k1000 = book.register(_level(address(vault), 1000));
        vault.setPrice(0.99e6); // down 1%
        assertTrue(book.check(k050), "0.5% is already going off");
        assertTrue(!book.check(k200), "2% waits");
        assertTrue(!book.check(k1000), "10% waits");
        vault.setPrice(0.85e6); // down 15%
        assertTrue(book.check(k200) && book.check(k1000), "a big loss trips them all");
    }

    function test_aCustomLevelFiresAndExitsTheOwnerThatArmedIt() public {
        bytes32 key = book.register(_level(address(vault), 200));
        vault.deposit(OWNER, 100e18);
        vm.prank(OWNER);
        vault.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(vault), RAW, 0, _keys(key)));

        vault.setPrice(0.985e6); // down 1.5%: inside the 2% level
        assertTrue(!book.poke(key), "does not fire inside the level");
        vault.setPrice(0.97e6); // down 3%
        vm.prank(KEEPER);
        assertTrue(book.poke(key), "fires past the level");

        vm.prank(KEEPER);
        router.exit(id, key, 0);
        assertEq(stable.balanceOf(OWNER), 97e6, "the owner is paid");
        assertEq(stable.balanceOf(KEEPER), 0, "the keeper is paid nothing");
        assertEq(vault.balanceOf(OWNER), 0, "shares gone");
    }

    function test_aLevelThePositionDidNotArmCannotExitIt() public {
        bytes32 k050 = book.register(_level(address(vault), 50));
        bytes32 k1000 = book.register(_level(address(vault), 1000));
        vault.deposit(OWNER, 100e18);
        vm.prank(OWNER);
        vault.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        bytes32 id = router.arm(_params(address(vault), RAW, 0, _keys(k1000))); // armed for a 10% loss only

        vault.setPrice(0.98e6); // down 2%
        assertTrue(book.poke(k050), "the 0.5% level fires");
        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.NotAuthorized.selector);
        router.exit(id, k050, 0);

        vm.prank(KEEPER);
        vm.expectRevert(ExitRouter.AlarmNotLive.selector);
        router.exit(id, k1000, 0); // the armed level has not fired
    }

    /// @dev v2: arm refuses a key that fired in the last day (AlarmNotClear), so a keeper can never be asked to exit on yesterday's firing.
    function test_aLevelCannotFireAgainForADay_andCannotBeArmedAfterFiring() public {
        bytes32 key = book.register(_level(address(vault), 100));
        assertTrue(book.armable(key), "a registered level that is clear is armable");
        vault.setPrice(0.98e6);
        assertTrue(!book.armable(key), "tripped, so not armable");
        assertTrue(book.poke(key), "fires");
        assertTrue(!book.poke(key), "not again at once");
        vault.deposit(OWNER, 100e18);
        vm.prank(OWNER);
        vault.approve(address(router), type(uint256).max);
        vm.warp(block.timestamp + 1);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.AlarmNotClear.selector, key));
        router.arm(_params(address(vault), RAW, 0, _keys(key)));
    }

    /// @dev Arming needs the key registered first: an unknown key is not armable, which is why the app registers a level when the user picks it.
    function test_anUnregisteredLevelIsNotArmable_untilItIsRegistered() public {
        AlarmBook.Detector memory d = _level(address(vault), 500);
        bytes32 key = book.keyOf(d);
        assertTrue(!book.armable(key), "unknown");
        vault.deposit(OWNER, 100e18);
        vm.prank(OWNER);
        vault.approve(address(router), type(uint256).max);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ExitRouter.AlarmNotClear.selector, key));
        router.arm(_params(address(vault), RAW, 0, _keys(key)));
        vm.prank(ATTACKER);
        book.register(d);
        assertTrue(book.armable(key), "registered by anyone, then armable");
        vm.prank(OWNER);
        router.arm(_params(address(vault), RAW, 0, _keys(key)));
    }

    function test_aLevelMustBeBetweenZeroAndTenThousandBasisPoints() public {
        vm.expectRevert(AlarmBook.BadDetector.selector);
        book.register(_level(address(vault), 0));
        vm.expectRevert(AlarmBook.BadDetector.selector);
        book.register(_level(address(vault), 10_000));
    }
}
