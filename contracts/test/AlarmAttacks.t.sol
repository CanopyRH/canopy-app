// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {AlarmBook} from "../src/AlarmBook.sol";
import {ExitRouter} from "../src/ExitRouter.sol";
import {Timelock} from "../src/Timelock.sol";
import {ERC4626Adapter} from "../src/adapters/ERC4626Adapter.sol";
import {MockERC20, MockVault, MockFeed} from "./Mocks.sol";

/// @dev ERC-4626 with real custody: totalAssets is the vault's token balance and deposits and redeems move real tokens.
contract RealVault is MockERC20 {
    MockERC20 public immutable assetToken;

    constructor(MockERC20 a) MockERC20(18) {
        assetToken = a;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function totalAssets() public view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    function convertToAssets(uint256 s) public view returns (uint256) {
        return totalSupply == 0 ? s : (s * totalAssets()) / totalSupply;
    }

    function maxRedeem(address o) external view returns (uint256) {
        return balanceOf[o];
    }

    function deposit(uint256 a, address to) external returns (uint256 s) {
        s = totalSupply == 0 ? a : (a * totalSupply) / totalAssets();
        assetToken.transferFrom(msg.sender, address(this), a);
        mint(to, s);
    }

    function redeem(uint256 s, address receiver, address owner) external returns (uint256 a) {
        require(msg.sender == owner, "owner");
        a = convertToAssets(s);
        _burn(owner, s);
        assetToken.transfer(receiver, a);
    }

    /// @dev Stand-in for a real exploit that takes assets out of the vault.
    function exploitDrain(address to, uint256 a) external {
        assetToken.transfer(to, a);
    }
}

/// @dev One transaction. Its token balance stands in for a free flash loan.
contract FlashAttacker {
    function flash(AlarmBook book, RealVault v, bytes32 key, uint256 loan) external {
        v.assetToken().approve(address(v), loan);
        uint256 s = v.deposit(loan, address(this));
        book.checkpoint(key);
        v.redeem(s, address(this), address(this));
    }
}

/// @notice Each of these was a working attack in an internal review. They now pin the fixes.
contract AlarmAttackTest is Base {
    uint256 internal constant PK_A = 0xA1;
    uint256 internal constant PK_B = 0xB2;
    uint32 internal constant WINDOW = 3600;
    bytes32 internal constant EVIDENCE = keccak256("report");

    MockERC20 internal asset;
    RealVault internal rv;
    FlashAttacker internal fa;

    function setUp() public override {
        super.setUp();
        asset = new MockERC20(18);
        rv = new RealVault(asset);
        fa = new FlashAttacker();
        vm.startPrank(ADMIN);
        book.setWatcher(vm.addr(PK_A), true);
        book.setWatcher(vm.addr(PK_B), true);
        vm.stopPrank();
    }
}
