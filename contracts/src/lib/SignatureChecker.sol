// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC1271} from "../interfaces/IERC1271.sol";

/// @notice ECDSA (EOA) + ERC-1271 (smart account) checks.
/// @dev EIP-7702 EOAs have code, so for accounts with code we try ERC-1271 first and fall back to
/// plain ECDSA recovery against the account address.
library SignatureChecker {
    // secp256k1n / 2
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function tryRecover(bytes32 hash, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (uint256(s) > HALF_N) return address(0);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(hash, v, r, s);
    }

    function isValidSignatureNow(address signer, bytes32 hash, bytes memory sig) internal view returns (bool) {
        if (signer == address(0)) return false;
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) =
                signer.staticcall(abi.encodeWithSelector(IERC1271.isValidSignature.selector, hash, sig));
            if (ok && ret.length >= 32 && abi.decode(ret, (bytes32)) == bytes32(IERC1271.isValidSignature.selector)) {
                return true;
            }
        }
        address rec = tryRecover(hash, sig);
        return rec != address(0) && rec == signer;
    }
}
