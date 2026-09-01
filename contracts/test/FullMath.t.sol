// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FullMath} from "../src/lib/FullMath.sol";

contract FullMathTest {
    function exposed(uint256 x, uint256 y, uint256 d) external pure returns (uint256) {
        return FullMath.mulDiv(x, y, d);
    }

    function testFuzz_matchesPlainMath(uint128 x, uint128 y, uint128 d) public pure {
        if (d == 0) return;
        require(FullMath.mulDiv(x, y, d) == (uint256(x) * y) / d, "plain");
    }

    function testFuzz_fullWidthRoundTrip(uint256 x, uint256 d) public pure {
        if (d == 0) return;
        require(FullMath.mulDiv(x, d, d) == x, "x * d / d");
    }

    function test_maxValues() public pure {
        uint256 m = type(uint256).max;
        require(FullMath.mulDiv(m, m, m) == m, "max");
        require(FullMath.mulDiv(m, 2, 4) == m / 2, "above 256 bits");
    }

    function test_overflowAndZeroRevert() public view {
        (bool a,) = address(this).staticcall(abi.encodeCall(this.exposed, (type(uint256).max, 2, 1)));
        (bool b,) = address(this).staticcall(abi.encodeCall(this.exposed, (1, 1, 0)));
        require(!a && !b, "reverts");
    }
}
