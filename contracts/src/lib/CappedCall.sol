// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A staticcall with a gas cap that copies a fixed number of return words, so a hostile or broken target can
/// burn at most the cap and can't make the caller copy a huge return payload.
library CappedCall {
    /// @param target The contract to read.
    /// @param data The calldata.
    /// @param gasCap The most gas the target may use.
    /// @param words How many 32-byte return words the caller needs (at most 5). Extra return data is never copied.
    /// @return ok True when the call succeeded and returned at least `words` words.
    /// @return succeeded True when the call itself did not revert or run out of gas, whatever it returned.
    /// @return out The first `words` return words (the rest are zero).
    /// @return used The gas the call took, the call's own overhead included.
    function read(address target, bytes memory data, uint256 gasCap, uint256 words)
        internal
        view
        returns (bool ok, bool succeeded, uint256[5] memory out, uint256 used)
    {
        uint256 size;
        uint256 g0 = gasleft();
        assembly ("memory-safe") {
            succeeded := staticcall(gasCap, target, add(data, 0x20), mload(data), out, mul(words, 0x20))
            size := returndatasize()
        }
        used = g0 - gasleft();
        ok = succeeded && size >= words * 32;
    }
}
