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

    function _deposit(address who, uint256 a) internal {
        asset.mint(who, a);
        vm.prank(who);
        asset.approve(address(rv), a);
        vm.prank(who);
        rv.deposit(a, who);
    }

    function _arm(address who, bytes32[] memory keys) internal returns (bytes32) {
        vm.prank(who);
        rv.approve(address(router), type(uint256).max);
        vm.prank(who);
        return router.arm(_params(address(rv), 0, 0, keys));
    }

    function _drainKey() internal returns (bytes32) {
        return book.register(_detector(AlarmBook.Kind.DRAIN, address(rv), 2500, WINDOW, 0, 0));
    }

    /// @dev The app's "Vault drain + confirmation" preset.
    function _bothKeys() internal returns (bytes32 drain, bytes32 quorum, bytes32 both) {
        drain = _drainKey();
        quorum = book.register(_detector(AlarmBook.Kind.QUORUM, address(rv), 2, 0, 0, 0));
        both = book.register(_detector(AlarmBook.Kind.BOTH, address(rv), 0, 1 days, drain, quorum));
    }

    /// @dev A keeper's routine pass, with a baseline ready at the end of it.
    function _period(bytes32 key) internal {
        vm.warp(block.timestamp + WINDOW / 2);
        book.checkpoint(key);
    }

    function _sigs(bytes32 digest) internal returns (address[] memory s, bytes[] memory g) {
        (uint256 lo, uint256 hi) = vm.addr(PK_A) < vm.addr(PK_B) ? (PK_A, PK_B) : (PK_B, PK_A);
        s = new address[](2);
        g = new bytes[](2);
        s[0] = vm.addr(lo);
        s[1] = vm.addr(hi);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(lo, digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(hi, digest);
        g[0] = abi.encodePacked(r0, s0, v0);
        g[1] = abi.encodePacked(r1, s1, v1);
    }
}
