// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.sol";
import {AlarmBook} from "../../src/AlarmBook.sol";
import {ExitRouter} from "../../src/ExitRouter.sol";
import {MockPausable} from "../Mocks.sol";

/// @dev Halmos symbolic-value cheatcodes.
interface SVM {
    function createUint256(string memory) external returns (uint256);
    function createAddress(string memory) external returns (address);
    function createBytes32(string memory) external returns (bytes32);
    function createBool(string memory) external returns (bool);
}

/// @notice Symbolic checks of the core rules, for halmos (`check_` functions; forge only compiles this file):
///   halmos --root contracts --match-contract RouterSymbolic
/// Each rule is written from the threat model, not from the code: a stranger's successful exit implies the key was
/// armed on that position and fired at or after the arming and within 24 hours; nobody but the owner gains; and `arm`
/// accepts a key only if it exists, reads clear, and has not fired in the last 24 hours.
contract RouterSymbolic is Base {
    SVM internal constant svm = SVM(0xF3993A62377BCd56AE39D773740A5390411E8BC9);
    bytes32 internal posId;
    uint256 internal armedAt;
    MockPausable internal other;
    bytes32 internal otherKey; // registered and fireable, but not armed on posId

    function setUp() public override {
        super.setUp();
        posId = _setup(OWNER, vault, 10e18, 0, 0); // RAW harbour, armed with pauseKey
        armedAt = block.timestamp;
        other = new MockPausable();
        otherKey = book.register(_detector(AlarmBook.Kind.PAUSED, address(other), 0, 0, 0, 0));
    }

    /// Anyone, any key, any amount, any timing, fired or not: only the owner is ever paid, and a stranger's exit
    /// succeeds only on the armed key fired in [armedAt, armedAt + ...] and no more than 24 hours before the exit.
    function check_exitPaysOnlyTheOwner_andAStrangerNeedsAFiredArmedKey() public {
        address caller = svm.createAddress("caller");
        bytes32 key = svm.createBytes32("key");
        uint256 amount = svm.createUint256("amount");
        bool fire = svm.createBool("fire");
        bool fireOther = svm.createBool("fireOther");
        uint256 dtFire = svm.createUint256("dtFire");
        uint256 dtExit = svm.createUint256("dtExit");
        vm.assume(dtFire < 400 days && dtExit < 400 days);
        vm.assume(caller != address(router) && caller != address(adapter) && caller != address(vault));

        vm.warp(block.timestamp + dtFire);
        uint256 firedAt;
        if (fire) {
            pausable.setPaused(true);
            if (book.poke(pauseKey)) firedAt = block.timestamp;
        }
        if (fireOther) {
            other.setPaused(true);
            book.poke(otherKey);
        }
        vm.warp(block.timestamp + dtExit);

        uint256 callerStable = stable.balanceOf(caller);
        uint256 callerShares = vault.balanceOf(caller);
        uint256 ownerStable = stable.balanceOf(OWNER);

        vm.prank(caller);
        (bool ok,) = address(router).call(abi.encodeCall(router.exit, (posId, key, amount)));

        if (caller != OWNER) {
            assert(stable.balanceOf(caller) == callerStable);
            assert(vault.balanceOf(caller) == callerShares);
            if (ok) {
                assert(key == pauseKey);
                assert(firedAt != 0 && firedAt >= armedAt && block.timestamp <= firedAt + 1 days);
            }
        }
        if (ok) assert(stable.balanceOf(OWNER) > ownerStable);
    }

    /// `arm` succeeds only for a registered key that reads clear and did not fire in the last 24 hours.
    function check_armRejectsKeysThatAreNotArmable() public {
        // The key is either registered key. Unknown keys are left to Reverts.t.sol `test_arm_AlarmNotClear_unknownKey`:
        // halmos 0.1.13 models unwritten mapping slots of a symbolic or unregistered key as symbolic storage, so it
        // can't resolve the detector target such a path would read.
        bool pickOther = svm.createBool("pickOther");
        bytes32 key = pickOther ? otherKey : pauseKey;
        bool fireFirst = svm.createBool("fireFirst");
        bool pausedNow = svm.createBool("pausedNow");
        uint256 dt = svm.createUint256("dt");
        vm.assume(dt < 400 days);

        uint256 firedAt;
        if (fireFirst) {
            pausable.setPaused(true);
            if (book.poke(pauseKey)) firedAt = block.timestamp;
        }
        vm.warp(block.timestamp + dt);
        pausable.setPaused(pausedNow);

        vm.prank(KEEPER); // a fresh owner, arming its own (empty) position on the same vault
        (bool ok,) = address(router).call(abi.encodeCall(router.arm, (_params(address(vault), 0, 0, _keys(key)))));
        if (ok) {
            assert(key == pauseKey || key == otherKey); // the only registered keys
            if (key == pauseKey) {
                assert(!pausedNow);
                assert(firedAt == 0 || block.timestamp >= firedAt + 1 days);
            }
        }
    }

    /// The owner's own exit is never gated by an alarm: with shares and an approval, it succeeds whatever the alarm.
    function check_ownerExitNeedsNoAlarm() public {
        bytes32 key = svm.createBytes32("key");
        uint256 dt = svm.createUint256("dt");
        vm.assume(dt < 400 days);
        vm.warp(block.timestamp + dt);
        vm.prank(OWNER);
        (bool ok,) = address(router).call(abi.encodeCall(router.exit, (posId, key, 0)));
        assert(ok);
        assert(stable.balanceOf(OWNER) == 10e6);
    }
}
