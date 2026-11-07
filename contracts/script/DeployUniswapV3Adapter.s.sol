// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitRouter} from "../src/ExitRouter.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {INonfungiblePositionManager} from "../src/interfaces/IUniswapV3.sol";

interface AdapterDeployVm {
    function envAddress(string calldata) external view returns (address);
    function envOr(string calldata, address) external view returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Deploys the Uniswap v3 adapter for an ExitRouter that is already live. Separate from Deploy.s.sol, so
/// the v1 deploy path is unchanged. The adapter starts disabled: the admin enables it with
/// setAdapter(adapter, true), from the Safe batch services/deploy/enable-adapter.ts writes.
contract DeployUniswapV3Adapter {
    AdapterDeployVm internal constant vm = AdapterDeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bool public IS_SCRIPT = true;
    address public constant BASE_POSITIONS = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address public constant ROBINHOOD_POSITIONS = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;

    error NoCode(string what);
    error WrongPositionManager();
    error AdminExpired();
    error WiringFailed(string what);

    /// @notice The canonical NonfungiblePositionManager per mainnet, or zero where none is pinned.
    function positionsFor(uint256 chainId) public pure returns (address) {
        if (chainId == 8453) return BASE_POSITIONS;
        if (chainId == 4663) return ROBINHOOD_POSITIONS;
        return address(0);
    }

    function run() external returns (UniswapV3Adapter adapter) {
        address router = vm.envAddress("ROUTER");
        address positions = vm.envOr("POSITION_MANAGER", positionsFor(block.chainid));
        validate(router, positions);
        vm.startBroadcast();
        adapter = deploy(router, positions);
        vm.stopBroadcast();
        check(router, positions, adapter);
    }

    function validate(address router, address positions) public view {
        if (router.code.length == 0) revert NoCode("router");
        if (positions.code.length == 0) revert NoCode("position manager");
        address pinned = positionsFor(block.chainid);
        if (pinned != address(0) && positions != pinned) revert WrongPositionManager();
        // Same WETH on both sides, or this is the wrong chain or the wrong router.
        if (INonfungiblePositionManager(positions).WETH9() != ExitRouter(payable(router)).WETH()) {
            revert WrongPositionManager();
        }
        // After expiry nobody can enable an adapter, so a deploy would be wasted.
        if (block.timestamp >= ExitRouter(payable(router)).ADMIN_EXPIRY()) revert AdminExpired();
    }

    function deploy(address router, address positions) public returns (UniswapV3Adapter) {
        return new UniswapV3Adapter(router, positions);
    }

    function check(address router, address positions, UniswapV3Adapter adapter) public view {
        if (adapter.ROUTER() != router) revert WiringFailed("router");
        if (address(adapter.POSITIONS()) != positions) revert WiringFailed("position manager");
        (address asset, bool isNft) = adapter.positionAsset(positions);
        if (asset != positions || !isNft) revert WiringFailed("position asset");
        if (ExitRouter(payable(router)).adapterAllowed(address(adapter))) revert WiringFailed("adapter must start disabled");
    }
}
