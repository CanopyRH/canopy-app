// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {MorphoHeadroomReader} from "../src/readers/MorphoHeadroomReader.sol";
import {IMorphoGuard} from "../src/interfaces/IMorphoGuard.sol";

interface HeadroomVm {
    function warp(uint256) external;
    function expectRevert() external;
}

contract ReaderMarket {
    uint256 public price = 1e36;
    uint256 public value = 2;
    uint256 public rate;
    uint128 public debt = 600;
    uint128 public shares = 600_000_000;
    uint128 public collateral = 1000;
    uint128 public last = 1000;

    function set(uint256 p, uint256 health, uint256 r, uint128 d, uint128 sh, uint128 c) external {
        price = p;
        value = health;
        rate = r;
        debt = d;
        shares = sh;
        collateral = c;
    }

    function idToMarketParams(bytes32) public view returns (IMorphoGuard.MarketParams memory) {
        return IMorphoGuard.MarketParams(address(1), address(2), address(this), address(this), 8e17);
    }

    function id() external view returns (bytes32) {
        return keccak256(abi.encode(idToMarketParams(0)));
    }

    function position(bytes32, address) external view returns (IMorphoGuard.Position memory) {
        return IMorphoGuard.Position(0, shares, collateral);
    }

    function market(bytes32) external view returns (IMorphoGuard.Market memory) {
        return IMorphoGuard.Market(1000, 1e9, debt, 600_000_000, last, 0);
    }

    function borrowRateView(IMorphoGuard.MarketParams memory, IMorphoGuard.Market memory)
        external
        view
        returns (uint256)
    {
        return rate;
    }
}

contract MorphoHeadroomReaderTest {
    HeadroomVm constant vm = HeadroomVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ReaderMarket m;
    MorphoHeadroomReader r;

    function setUp() public {
        vm.warp(1000);
        m = new ReaderMarket();
        r = new MorphoHeadroomReader(address(m), m.id(), address(this), address(m));
    }

    function test_capacityAndZeroDebt() public view {
        require(r.value() == 2501);
    }

    function test_staleHealthOrZeroPriceIsUnknown() public {
        m.set(1e36, 1, 0, 600, 600_000_000, 1000);
        vm.expectRevert();
        r.value();
        m.set(0, 2, 0, 600, 600_000_000, 1000);
        vm.expectRevert();
        r.value();
    }

    function test_interestReducesHeadroomAndLiquidationIsOne() public {
        m.set(1e36, 2, 1e14, 600, 600_000_000, 1000);
        vm.warp(2000);
        require(r.value() < 2501);
        m.set(1e36, 2, 0, 900, 600_000_000, 1000);
        require(r.value() == 1);
    }

    function test_noDebtNeedsNoPrice() public {
        m.set(0, 1, 0, 600, 0, 0);
        require(r.value() == 10001);
    }
}
