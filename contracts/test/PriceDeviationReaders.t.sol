// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {PriceDeviationReader, V3TwapDeviationReader} from "../src/readers/PriceDeviationReaders.sol";
import {MockERC20, MockFeed} from "./Mocks.sol";

interface PriceVm {
    function warp(uint256) external;
    function expectRevert() external;
}

contract ObservedPoolFixture {
    address public token0;
    address public token1;
    int56 public change;
    bool public fail;

    constructor(address a, address b) {
        token0 = a;
        token1 = b;
    }

    function set(int56 d, bool f) external {
        change = d;
        fail = f;
    }

    function observe(uint32[] calldata) external view returns (int56[] memory t, uint160[] memory secondsPerLiquidity) {
        require(!fail);
        t = new int56[](2);
        t[1] = change;
        secondsPerLiquidity = new uint160[](2);
    }
}

contract PriceDeviationReadersTest {
    PriceVm constant vm = PriceVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockFeed a;
    MockFeed b;
    PriceDeviationReader r;
    V3TwapDeviationReader t;
    ObservedPoolFixture pool;

    function setUp() public {
        vm.warp(1000);
        a = new MockFeed(1e8);
        b = new MockFeed(1e8);
        r = new PriceDeviationReader(address(a), address(b), 60, 60);
        pool = new ObservedPoolFixture(address(new MockERC20(18)), address(new MockERC20(18)));
        t = new V3TwapDeviationReader(address(pool), 60, address(a), address(b), 60, 60);
    }

    function test_feedDeviationAndUnknown() public {
        require(r.value() == 10001);
        a.set(95e6, 1000);
        require(r.value() == 9501);
        a.set(1e8, 1);
        vm.expectRevert();
        r.value();
    }

    function test_twapAndIndependentFeed() public {
        require(t.value() == 10001);
        pool.set(6931 * 60, false);
        uint256 score = t.value();
        require(score < 10 && score > 0);
        pool.set(0, true);
        vm.expectRevert();
        t.value();
    }

    function test_negativeTickRoundsDown() public {
        pool.set(-61, false);
        require(t.value() < 10001);
    }

    function testFuzz_tickMonotonicAndReciprocal(int24 tick) public view {
        tick = int24(int256(tick) % 800000);
        uint256 q = 1 << 128;
        uint256 p = t.ratioAtTick(tick);
        require(p > 0);
        if (tick < 887272) require(t.ratioAtTick(tick + 1) >= p);
        if (tick == 0) require(p == q);
    }

    // Independent Python Decimal (150 digits) vectors, not the Solidity exponentiation implementation.
    function test_decimalReferenceVectorsAcrossTickDomain() public view {
        _near(t.ratioAtTick(-887272), 1);
        _near(t.ratioAtTick(-600000), 2988638091247);
        _near(t.ratioAtTick(-100001), 15454975874056695976799298420624183);
        _near(t.ratioAtTick(-1), 340248342086729790484326174814286782777);
        _near(t.ratioAtTick(0), 340282366920938463463374607431768211456);
        _near(t.ratioAtTick(1), 340316395157630557309720944892511388277);
        _near(t.ratioAtTick(100001), 7492220640194537818789951915812825482248498);
        _near(t.ratioAtTick(600000), 38744098717210713842405763019033998922308668511860998126204606290);
        _near(t.ratioAtTick(887272), 115783384785599357989926955577258778532263228622883689072079342256665390203260);
    }

    function _near(uint256 actual, uint256 expected) internal pure {
        uint256 error = actual > expected ? actual - expected : expected - actual;
        require(error <= expected / 1e25 + 2);
    }
}
