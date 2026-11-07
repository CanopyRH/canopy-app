// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {
    FeedHealthReader,
    VaultLiquidityReader,
    PoolReserveReader,
    SessionReader,
    RiskReader
} from "../src/readers/RiskReaders.sol";
import {MockERC20, MockVault} from "./Mocks.sol";

interface ReaderVm {
    function warp(uint256) external;
    function expectRevert() external;
}

contract ReaderFeed {
    int256 public answer = 100;
    uint256 public updated = 1000;
    bool public paused;
    bool public broken;

    function set(int256 a, uint256 u, bool p, bool b) external {
        answer = a;
        updated = u;
        paused = p;
        broken = b;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken);
        return (1, answer, updated, updated, 1);
    }
}

contract RiskReadersTest {
    ReaderVm constant vm = ReaderVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testFeedHealthAndUnknown() public {
        vm.warp(1000);
        ReaderFeed f = new ReaderFeed();
        FeedHealthReader r = new FeedHealthReader(address(f), 60, address(f), f.paused.selector);
        require(r.value() == 2);
        vm.warp(1061);
        require(r.value() == 1);
        f.set(100, 1061, true, false);
        require(r.value() == 1);
        f.set(100, 1062, false, false);
        vm.expectRevert();
        r.value();
        f.set(100, 1061, false, true);
        vm.expectRevert();
        r.value();
    }

    function testSessionClosedExpiryAndBoundary() public {
        SessionReader.Window[] memory w = new SessionReader.Window[](2);
        w[0] = SessionReader.Window(100, 200);
        w[1] = SessionReader.Window(300, 400);
        SessionReader r = new SessionReader(w, 50, 500);
        vm.warp(199);
        require(r.value() == 2);
        vm.warp(200);
        require(r.value() == 1);
        vm.warp(300);
        require(r.value() == 101);
        vm.warp(500);
        vm.expectRevert();
        r.value();
        w[1].open = 199;
        vm.expectRevert();
        new SessionReader(w, 50, 500);
    }

    function testReserveLossNeedsAnIndependentConfirmation() public {
        MockERC20 t = new MockERC20(6);
        ReaderFeed pool = new ReaderFeed();
        PoolReserveReader r = new PoolReserveReader(address(t), address(pool), 100);
        require(r.value() == 1);
        t.mint(address(pool), 25);
        require(r.value() == 2501);
        t.mint(address(pool), 200);
        require(r.value() == 10001);
    }

    function testLiquidityEmptyWalletIsNotDanger() public {
        MockERC20 t = new MockERC20(6);
        MockVault v = new MockVault(t, 1e6);
        VaultLiquidityReader r = new VaultLiquidityReader(address(v), address(this));
        require(r.value() == 10001);
        v.mint(address(this), 1e18);
        require(r.value() == 1);
    }

    function testFuzzReserveRatio(uint128 amount, uint128 baseline) public {
        if (baseline == 0) baseline = 1;
        MockERC20 t = new MockERC20(6);
        ReaderFeed pool = new ReaderFeed();
        PoolReserveReader r = new PoolReserveReader(address(t), address(pool), baseline);
        t.mint(address(pool), amount);
        uint256 result = r.value();
        require(result >= 1 && result <= 10001);
        if (amount < baseline) require(result == uint256(amount) * 10000 / baseline + 1);
    }
}
