// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {BorrowGuard} from "../src/guards/BorrowGuard.sol";
import {IMorphoGuard} from "../src/interfaces/IMorphoGuard.sol";
import {MockERC20} from "./Mocks.sol";

interface GuardVm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert() external;
}

contract GuardBook {
    bool public live;

    function set(bool b) external {
        live = b;
    }

    function armable(bytes32) external pure returns (bool) {
        return true;
    }

    function isLive(bytes32, uint256) external view returns (bool) {
        return live;
    }
}

contract GuardMorpho is IMorphoGuard {
    MarketParams private params;
    Position private pos;
    Market private state;
    bool public failWithdraw;
    bool public reenter;
    bool public reentryBlocked;

    function enableReentry() external {
        reenter = true;
    }
    address public receiver;
    bytes32 public lastMarket;

    constructor(address loan, address collateral) {
        params = MarketParams(loan, collateral, address(9), address(8), 8e17);
        pos = Position(0, 1_000_000_000, 2000);
        state = Market(2000, 2_000_000_000, 1000, 1_000_000_000, 1, 0);
        MockERC20(collateral).mint(address(this), 2000);
    }

    function id() external view returns (bytes32) {
        return keccak256(abi.encode(params));
    }

    function setFail(bool b) external {
        failWithdraw = b;
    }

    function idToMarketParams(bytes32) external view returns (MarketParams memory) {
        return params;
    }

    function position(bytes32, address) external view returns (Position memory) {
        return pos;
    }

    function market(bytes32) external view returns (Market memory) {
        return state;
    }

    function accrueInterest(MarketParams memory p) external {
        require(keccak256(abi.encode(p)) == keccak256(abi.encode(params)));
        if (reenter) {
            try BorrowGuard(msg.sender).repay(1, bytes32(uint256(1))) {
                revert("reentered");
            } catch {
                reentryBlocked = true;
            }
        }
    }

    function repay(MarketParams memory p, uint256 assets, uint256 shares, address, bytes memory data)
        external
        returns (uint256, uint256)
    {
        require(data.length == 0);
        lastMarket = keccak256(abi.encode(p));
        require(lastMarket == keccak256(abi.encode(params)));
        if (shares > 0) {
            assets = (shares * (uint256(state.totalBorrowAssets) + 1) + state.totalBorrowShares + 999999)
                / (state.totalBorrowShares + 1000000);
        } else {
            shares = assets * (uint256(state.totalBorrowShares) + 1000000) / (state.totalBorrowAssets + 1);
        }
        MockERC20(params.loanToken).transferFrom(msg.sender, address(this), assets);
        pos.borrowShares -= uint128(shares);
        state.totalBorrowAssets -= uint128(assets);
        state.totalBorrowShares -= uint128(shares);
        return (assets, shares);
    }

    function withdrawCollateral(MarketParams memory, uint256 assets, address, address to) external {
        require(!failWithdraw);
        receiver = to;
        pos.collateral -= uint128(assets);
        MockERC20(params.collateralToken).transfer(to, assets);
    }
}

contract BorrowGuardTest {
    GuardVm constant vm = GuardVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant OWNER = address(0xa11ce);
    address constant KEEPER = address(0xb0b);
    bytes32 constant KEY = bytes32(uint256(1));
    MockERC20 loan;
    MockERC20 collateral;
    GuardBook book;
    GuardMorpho morpho;
    BorrowGuard guard;

    function setUp() public {
        vm.warp(1000);
        loan = new MockERC20(6);
        collateral = new MockERC20(6);
        book = new GuardBook();
        morpho = new GuardMorpho(address(loan), address(collateral));
        guard = new BorrowGuard(OWNER, address(morpho), address(book), morpho.id());
        loan.mint(OWNER, 10000);
        vm.prank(OWNER);
        loan.approve(address(guard), 10000);
    }

    function arm(uint256 cap, uint16 withdrawBps) internal {
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = KEY;
        vm.prank(OWNER);
        guard.arm(cap, withdrawBps, 2000, keys);
    }

    function testKeeperNeedsOwnerArmAndLiveChosenAlarm() public {
        arm(100, 0);
        vm.prank(KEEPER);
        vm.expectRevert();
        guard.repay(100, KEY);
        book.set(true);
        vm.prank(KEEPER);
        vm.expectRevert();
        guard.repay(100, bytes32(uint256(2)));
    }

    function testCapCannotBeExceededAndCollateralStaysByDefault() public {
        arm(100, 0);
        book.set(true);
        vm.prank(KEEPER);
        (uint256 paid, uint256 withdrawn) = guard.repay(1000, KEY);
        require(paid == 100 && withdrawn == 0);
        require(loan.balanceOf(OWNER) == 9900);
        require(guard.remainingBudget() == 0);
        require(loan.allowance(address(guard), address(morpho)) == 0);
        require(collateral.balanceOf(KEEPER) == 0);
    }

    function testProportionalCollateralOnlyGoesToOwner() public {
        arm(1000, 10000);
        book.set(true);
        vm.prank(KEEPER);
        (uint256 paid, uint256 withdrawn) = guard.repay(500, KEY);
        require(paid == 500 && withdrawn == 1000);
        require(morpho.receiver() == OWNER);
        require(collateral.balanceOf(OWNER) == 1000);
        require(collateral.balanceOf(KEEPER) == 0);
    }

    function testWithdrawalFailureDoesNotUndoRepayment() public {
        arm(1000, 10000);
        morpho.setFail(true);
        vm.prank(OWNER);
        (uint256 paid, uint256 withdrawn) = guard.repay(500, KEY);
        require(paid == 500 && withdrawn == 0);
        require(guard.remainingBudget() == 500);
    }

    function testFullDebtAndExpiryDisarm() public {
        arm(2000, 10000);
        vm.prank(OWNER);
        (uint256 paid, uint256 withdrawn) = guard.repay(2000, KEY);
        require(paid == 1000 && withdrawn == 2000 && !guard.active());
    }

    function testOnlyOwnerCanChangeFloor() public {
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = KEY;
        vm.prank(KEEPER);
        vm.expectRevert();
        guard.arm(1, 0, 2000, keys);
        arm(100, 0);
        vm.prank(KEEPER);
        vm.expectRevert();
        guard.disarm();
        vm.warp(2000);
        vm.prank(OWNER);
        vm.expectRevert();
        guard.repay(1, KEY);
    }

    function testFuzzBudgetAndRecipient(uint128 cap, uint128 requested) public {
        cap = uint128(uint256(cap) % 999 + 1);
        requested = uint128(uint256(requested) % 2000 + 1);
        arm(cap, 0);
        book.set(true);
        vm.prank(KEEPER);
        (uint256 paid,) = guard.repay(requested, KEY);
        require(paid <= cap && paid <= requested);
        require(loan.balanceOf(KEEPER) == 0 && collateral.balanceOf(KEEPER) == 0);
    }

    function testDependencyCannotReenterRepayment() public {
        arm(100, 0);
        book.set(true);
        morpho.enableReentry();
        vm.prank(KEEPER);
        guard.repay(100, KEY);
        require(morpho.reentryBlocked() && guard.remainingBudget() == 0);
        require(loan.balanceOf(OWNER) == 9900);
    }

    function testMissingAllowanceRollsBackBudget() public {
        arm(100, 0);
        vm.prank(OWNER);
        loan.approve(address(guard), 0);
        vm.prank(OWNER);
        vm.expectRevert();
        guard.repay(100, KEY);
        require(guard.remainingBudget() == 100);
    }
}
