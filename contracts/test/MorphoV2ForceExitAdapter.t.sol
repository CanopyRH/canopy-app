// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {MorphoV2ForceExitAdapter} from "../src/adapters/MorphoV2ForceExitAdapter.sol";
import {MockERC20} from "./Mocks.sol";

interface ForceVm {
    function prank(address) external;
    function expectRevert() external;
}

contract ForceVaultFixture is MockERC20 {
    MockERC20 public asset;
    bool public isAdapterAllowed = true;
    uint256 public penalty = 1e16;
    bool public blockedExit;
    bool public lie;
    uint256 public calls;

    constructor(MockERC20 a) MockERC20(6) {
        asset = a;
    }

    function configure(uint256 p, bool blocked, bool l) external {
        penalty = p;
        blockedExit = blocked;
        lie = l;
    }

    function isAdapter(address) external view returns (bool) {
        return isAdapterAllowed;
    }

    function forceDeallocatePenalty(address) external view returns (uint256) {
        return penalty;
    }

    function convertToAssets(uint256 n) external pure returns (uint256) {
        return n;
    }

    function redeem(uint256 n, address to, address owner) external returns (uint256) {
        require(!blockedExit && msg.sender == owner);
        _burn(owner, n);
        asset.transfer(to, n);
        return n;
    }

    function forceDeallocate(address, bytes calldata, uint256 amount, address owner) external returns (uint256) {
        calls++;
        require(msg.sender == owner);
        uint256 burn = (amount * penalty + 1e18 - 1) / 1e18;
        _burn(owner, burn);
        asset.mint(address(this), amount);
        return lie ? 0 : burn;
    }
}

contract MorphoV2ForceExitAdapterTest {
    ForceVm constant vm = ForceVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockERC20 token;
    ForceVaultFixture vault;
    MorphoV2ForceExitAdapter adapter;

    function setUp() public {
        token = new MockERC20(6);
        vault = new ForceVaultFixture(token);
        adapter = new MorphoV2ForceExitAdapter(address(this), address(vault), address(token), hex"1234", 100);
        vault.mint(address(adapter), 1000);
    }

    function test_forceDeallocatesAndPaysRouterWithinCap() public {
        adapter.unwind(address(vault), 1000);
        require(token.balanceOf(address(this)) == 990);
        require(vault.calls() == 1);
        require(vault.balanceOf(address(adapter)) == 0);
    }

    function test_liquidExitDoesNotPayPenalty() public {
        token.mint(address(vault), 1000);
        adapter.unwind(address(vault), 1000);
        require(token.balanceOf(address(this)) == 1000 && vault.calls() == 0);
    }

    function test_penaltyIncreaseAndWrongCallerRejected() public {
        vault.configure(2e16, false, false);
        vm.expectRevert();
        adapter.unwind(address(vault), 1000);
        require(vault.balanceOf(address(adapter)) == 1000);
        vm.prank(address(8));
        vm.expectRevert();
        adapter.unwind(address(vault), 1000);
    }

    function test_failedExitRollsBackPenalty() public {
        vault.configure(1e16, true, false);
        vm.expectRevert();
        adapter.unwind(address(vault), 1000);
        require(vault.balanceOf(address(adapter)) == 1000 && vault.calls() == 0);
    }

    function test_badPenaltyReturnCannotHideBurn() public {
        vault.configure(1e16, false, true);
        vm.expectRevert();
        adapter.unwind(address(vault), 1000);
        require(vault.balanceOf(address(adapter)) == 1000);
    }
}
