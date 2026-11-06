// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "../Base.sol";
import {AlarmBook} from "../../src/AlarmBook.sol";
import {MockVault} from "../Mocks.sol";

/// @dev A PAUSED view that reports "paused" whenever it was handed less than the full read cap. If AlarmBook ever
/// passed it less than TARGET_READ_GAS, the reading would depend on the caller's gas and this probe would fire.
contract GasProbe {
    function paused() external view returns (bool) {
        return gasleft() < 999_000;
    }
}

/// @notice V3-02 and the 63/64 checks.
///
/// V3-02: the keeper in `services/` sends every poke and checkpoint with a gas limit of at most SMALL_CALL_GAS
/// (1,000,000, services/src/keeper/keeper.ts:33), derived from the simulated gasUsed (`used * 3 / 2 + 100_000`,
/// keeper.ts:46). v2's AlarmBook refuses any target read unless 1,025,873 gas is left (`TARGET_READ_GAS +
/// READ_GAS_OVERHEAD`), however little the read uses. So on v2 every keeper poke and checkpoint of a SHARE_DROP, PAUSED,
/// ADDRESS_CHANGE, DRAIN or PRICE_BELOW key reverts NotEnoughGas on chain: the keeper can't fire those alarms or keep
/// DRAIN references and share marks fresh. The services also still carry the v1 router ABI (`setFeed`, `swapConfig`,
/// `arm` without `swaps`, services/src/chain/abi.generated.ts). The calls below give the exact limits the keeper would.
contract V3ReadGasTest is Base {
    bytes32 internal shareKey;

    function setUp() public override {
        super.setUp();
        vault.deposit(OWNER, 100e18);
        shareKey = book.register(_detector(AlarmBook.Kind.SHARE_DROP, address(vault), 50, 0, 0, 0));
    }

    /// @dev What the keeper does: simulate with plenty of gas, then send with min(used * 1.5 + 100k, 1M).
    function _keeperLimit(bytes memory data) internal returns (uint256 limit) {
        uint256 g0 = gasleft();
        (bool ok,) = address(book).call{gas: 30_000_000}(data);
        uint256 used = g0 - gasleft();
        assertTrue(ok, "simulation succeeds");
        limit = (used * 3) / 2 + 100_000;
        if (limit > 1_000_000) limit = 1_000_000;
    }

    function test_V3_02_keeperGasLimitsRevertOnEveryTargetRead() public {
        pausable.setPaused(true);
        bytes memory pokeData = abi.encodeCall(book.poke, (pauseKey));
        // The simulation would fire it; measure on a snapshot-free copy by reading `check` instead of poking.
        uint256 limit = _keeperLimit(abi.encodeCall(book.check, (pauseKey)));
        assertTrue(limit < 1_000_001, "the keeper's limit is at most 1M");
        (bool ok, bytes memory ret) = address(book).call{gas: limit}(pokeData);
        assertTrue(!ok && bytes4(ret) == AlarmBook.NotEnoughGas.selector, "the keeper's poke reverts");
        (ok, ret) = address(book).call{gas: 1_000_000}(pokeData);
        assertTrue(!ok && bytes4(ret) == AlarmBook.NotEnoughGas.selector, "even at the 1M cap");
        assertTrue(!book.isLive(pauseKey, 1 days), "the paused vault's alarm never fired");

        // Checkpoints (share marks, DRAIN references) fail the same way.
        vault.setPrice(2e6);
        (ok, ret) = address(book).call{gas: 1_000_000}(abi.encodeCall(book.checkpoint, (shareKey)));
        assertTrue(!ok && bytes4(ret) == AlarmBook.NotEnoughGas.selector, "checkpoint reverts at 1M");
        (uint256 hi) = _baseline(shareKey);
        assertEq(hi, 1e6, "the mark never moved");

        // Control: about 1.1M is enough, and the poke itself uses a small fraction of that.
        uint256 g0 = gasleft();
        (ok,) = address(book).call{gas: 1_100_000}(pokeData);
        uint256 used = g0 - gasleft();
        assertTrue(ok && book.isLive(pauseKey, 0), "with 1.1M it fires");
        assertTrue(used < 100_000, "while using under 100k");
    }

    function _baseline(bytes32 k) internal view returns (uint256 b) {
        (,,, b,,,) = book.state(k);
    }

    /// Checked and fine: whatever gas the caller sends, the target either gets its full cap or the call reverts
    /// NotEnoughGas. Sweeping the boundary 1,000 gas at a time, the probe never sees a short cap, so it never fires.
    function test_capIsAlwaysDeliveredInFull_orTheCallReverts() public {
        GasProbe probe = new GasProbe();
        bytes32 k = book.register(_detector(AlarmBook.Kind.PAUSED, address(probe), 0, 0, 0, 0));
        uint256 firstOk;
        for (uint256 g = 1_000_000; g < 1_060_000; g += 250) {
            (bool ok, bytes memory ret) = address(book).call{gas: g}(abi.encodeCall(book.poke, (k)));
            if (!ok) {
                assertTrue(bytes4(ret) == AlarmBook.NotEnoughGas.selector || ret.length == 0, "only a gas refusal");
                continue;
            }
            if (firstOk == 0) firstOk = g;
            assertTrue(!abi.decode(ret, (bool)), "never fired: the probe always got its full cap");
        }
        assertTrue(firstOk != 0, "the sweep crossed the threshold");
        assertTrue(!book.isLive(k, 1 days), "never fired");
    }
}
