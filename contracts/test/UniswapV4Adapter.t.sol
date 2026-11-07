// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {UniswapV4Adapter, IV4Positions} from "../src/adapters/UniswapV4Adapter.sol";
import {MockERC20} from "./Mocks.sol";

interface V4Vm {
    function prank(address) external;
    function expectRevert() external;
    function deal(address, uint256) external;
}

contract V4Mock is IV4Positions {
    PoolKey private pool;
    uint128 public liquidity = 100;
    address public holder;
    address public payout;
    bool public broken;

    constructor(address a, address b) {
        pool = PoolKey(a, b, 500, 10, address(0));
    }

    function setHook(address h) external {
        pool.hooks = h;
    }

    function setHolder(address h) external {
        holder = h;
    }

    function fail(bool b) external {
        broken = b;
    }

    function getPoolAndPositionInfo(uint256) external view returns (PoolKey memory, uint256) {
        return (pool, 0);
    }

    function getPositionLiquidity(uint256) external view returns (uint128) {
        return liquidity;
    }

    function modifyLiquidities(bytes calldata data, uint256 deadline) external payable {
        require(!broken && holder == msg.sender && deadline == block.timestamp);
        (bytes memory actions, bytes[] memory params) = abi.decode(data, (bytes, bytes[]));
        require(keccak256(actions) == keccak256(hex"0111") && params.length == 2);
        (uint256 id, uint256 amount, uint128 min0, uint128 min1, bytes memory hookData) =
            abi.decode(params[0], (uint256, uint256, uint128, uint128, bytes));
        require(id == 1 && amount == liquidity && min0 == 0 && min1 == 0 && hookData.length == 0);
        (address a, address b, address to) = abi.decode(params[1], (address, address, address));
        require(a == pool.currency0 && b == pool.currency1);
        payout = to;
        liquidity = 0;
        if (a == address(0)) {
            (bool ok,) = to.call{value: 5}("");
            require(ok);
        } else {
            MockERC20(a).mint(to, 5);
        }
        MockERC20(b).mint(to, 7);
    }

    function transferFrom(address from, address to, uint256) external {
        require(holder == from && msg.sender == from);
        holder = to;
    }
    receive() external payable {}
}

contract UniswapV4AdapterTest {
    V4Vm constant vm = V4Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    receive() external payable {}

    function testUnwindReturnsBothTokensAndNftToRouter() public {
        MockERC20 a = new MockERC20(18);
        MockERC20 b = new MockERC20(6);
        (address x, address y) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        V4Mock p = new V4Mock(x, y);
        UniswapV4Adapter adapter = new UniswapV4Adapter(address(this), address(p));
        p.setHolder(address(adapter));
        adapter.unwind(address(p), 1);
        require(p.holder() == address(this) && p.payout() == address(this) && p.liquidity() == 0);
        require(MockERC20(x).balanceOf(address(this)) == 5 && MockERC20(y).balanceOf(address(this)) == 7);
    }

    function testNativeCurrencyAndUnsupportedHooks() public {
        MockERC20 b = new MockERC20(6);
        V4Mock p = new V4Mock(address(0), address(b));
        UniswapV4Adapter adapter = new UniswapV4Adapter(address(this), address(p));
        p.setHolder(address(adapter));
        vm.deal(address(p), 10);
        uint256 beforeBalance = address(this).balance;
        adapter.unwind(address(p), 1);
        require(address(this).balance == beforeBalance + 5);
        p.setHook(address(1));
        vm.expectRevert();
        adapter.outputs(address(p), 1);
    }

    function testWrongCallerTargetAndAtomicFailure() public {
        MockERC20 b = new MockERC20(6);
        V4Mock p = new V4Mock(address(0), address(b));
        UniswapV4Adapter adapter = new UniswapV4Adapter(address(this), address(p));
        p.setHolder(address(adapter));
        vm.prank(address(99));
        vm.expectRevert();
        adapter.unwind(address(p), 1);
        vm.expectRevert();
        adapter.outputs(address(b), 1);
        p.fail(true);
        vm.expectRevert();
        adapter.unwind(address(p), 1);
        require(p.liquidity() == 100 && p.holder() == address(adapter));
    }
}
