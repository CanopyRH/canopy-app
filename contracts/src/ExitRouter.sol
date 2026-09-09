// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, IERC721, IAggregatorV3, IV3SwapRouter, IWETH} from "./interfaces/IExternal.sol";
import {IExitAdapter} from "./interfaces/IExitAdapter.sol";
import {IAlarmBook} from "./interfaces/IAlarmBook.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {FullMath} from "./lib/FullMath.sol";

/// @title ExitRouter
/// @notice Pulls a user's DeFi position back to the user's own wallet. That is all it can do.
///
/// Hard rules enforced here (not in any prompt, bot or service):
/// 1. Funds go to the position owner and nowhere else. `exit` has no recipient parameter; every
///    outbound transfer in this contract is addressed to `p.owner` (or WETH, when wrapping ETH).
/// 2. Who may call `exit`: the owner, or anyone at all while an alarm the owner armed for that
///    position is live in AlarmBook. A rogue keeper can therefore, at worst, exit the owner early.
/// 3. Exits are never gated: no pause, fee, plan check or oracle can block `exit`. The optional swap
///    is skipped whenever the oracle is stale, the stablecoin is off its peg, no route is set, or the
///    pool cannot fill at the oracle-bounded minimum.
/// 4. The owner can revoke instantly: `disarm`, `disarmAll`, or revoking the token approval.
/// 5. Admin (a Timelock, delay set at deploy) can only set adapters, feeds and swap routes, and only until ADMIN_EXPIRY.
///    Disabling an adapter never affects positions already armed. The guardian can only pause NEW
///    arming. Nobody can upgrade this contract.
contract ExitRouter is ReentrancyGuard {
    using SafeTransferLib for address;

    uint8 public constant HARBOUR_RAW = 0;
    uint8 public constant HARBOUR_STABLE = 1;
    uint16 public constant MAX_SLIP_CAP_BPS = 1000; // 10% ceiling for the owner's own exits
    uint8 public constant MAX_TOKEN_DECIMALS = 36;
    uint16 public constant THIRD_PARTY_SLIP_CAP_BPS = 100; // 1% ceiling when anyone else runs the exit
    uint256 public constant ALARM_TTL = 1 days;
    uint256 public constant MAX_KEYS = 8;
    uint256 public constant STABLE_FLOOR_BPS = 9850; // never swap INTO the stablecoin below $0.985
    uint8 internal constant STABLE_DECIMALS = 6;

    address public immutable STABLE;
    address public immutable WETH;
    address public immutable SWAP_ROUTER;
    IAlarmBook public immutable ALARMS;
    address public immutable ADMIN; // Timelock (48h)
    uint256 public immutable ADMIN_EXPIRY;
    address public immutable STABLE_FEED;
    uint32 public immutable STABLE_FEED_HEARTBEAT;

    struct Feed {
        address feed;
        uint32 heartbeat;
        uint8 tokenDecimals;
    }

    struct Position {
        address owner;
        uint64 armedAt;
        uint64 epoch;
        bool active;
        uint8 harbour;
        uint16 maxSlipBps;
        uint64 swapConfig; // swap settings the owner armed under
        address adapter;
        address target;
        address asset;
        bool isNft;
        uint256 tokenId;
    }

    struct ArmParams {
        address adapter;
        address target;
        uint256 tokenId;
        uint8 harbour;
        uint16 maxSlipBps;
        bytes32 termsHash;
        bytes32[] keys;
    }

    address public guardian;
    bool public armingPaused;
    uint64 public swapConfig; // rises with every feed or route change
}
