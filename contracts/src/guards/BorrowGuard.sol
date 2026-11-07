// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {IMorphoGuard} from "../interfaces/IMorphoGuard.sol";
import {IAlarmBook} from "../interfaces/IAlarmBook.sol";
import {IERC20} from "../interfaces/IExternal.sol";
import {FullMath} from "../lib/FullMath.sol";
import {SafeTransferLib} from "../lib/SafeTransferLib.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";

/// @notice Audit candidate: immutable one-owner, one-market allowance repayment. No borrowing, swaps or arbitrary calls.
/// @dev Morpho authorization is account-wide, but this contract's code can touch only MARKET_ID for OWNER.
/// Not deployed or offered in the app. External audit and real-deployment fork tests are required before activation.
contract BorrowGuard is ReentrancyGuard {
    address public immutable OWNER;
    IMorphoGuard public immutable MORPHO;
    IAlarmBook public immutable ALARM_BOOK;
    bytes32 public immutable MARKET_ID;
    IMorphoGuard.MarketParams private _params;
    uint256 public remainingBudget;
    uint16 public withdrawShareBps;
    uint64 public expiresAt;
    bool public active;
    bytes32[] private _keys;
    error NotOwner();
    error BadConfiguration();
    error NotArmed();
    error NoAlarm();
    error InvalidRepayment();
    error UnsupportedToken();
    event Armed(uint256 budget, uint16 withdrawShareBps, uint64 expiresAt, bytes32[] keys);
    event Disarmed();
    event Repaid(address indexed owner, bytes32 indexed market, uint256 assets, uint256 shares, uint256 collateralPaid);
    event CollateralHeld(uint256 amount);

    constructor(address owner, address morpho, address book, bytes32 marketId) {
        if (owner == address(0) || morpho.code.length == 0 || book.code.length == 0) revert BadConfiguration();
        OWNER = owner;
        MORPHO = IMorphoGuard(morpho);
        ALARM_BOOK = IAlarmBook(book);
        MARKET_ID = marketId;
        IMorphoGuard.MarketParams memory p = MORPHO.idToMarketParams(marketId);
        if (
            keccak256(abi.encode(p)) != marketId || p.loanToken.code.length == 0 || p.collateralToken.code.length == 0
                || p.loanToken == p.collateralToken
        ) revert BadConfiguration();
        _params = p;
    }
    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner();
        _;
    }

    function keys() external view returns (bytes32[] memory) {
        return _keys;
    }

    /// @param withdrawBps Fraction of the proportionally released collateral to withdraw (0 keeps all collateral).
    /// A value of 10000 preserves the prior collateral/debt ratio, rather than targeting a lower LTV.
    function arm(uint256 budget, uint16 withdrawBps, uint64 expiry, bytes32[] calldata alarmKeys)
        external
        onlyOwner
        nonReentrant
    {
        if (
            budget == 0 || withdrawBps > 10000 || expiry <= block.timestamp || expiry > block.timestamp + 365 days
                || alarmKeys.length == 0 || alarmKeys.length > 8
        ) revert BadConfiguration();
        delete _keys;
        for (uint256 i; i < alarmKeys.length; i++) {
            if (!ALARM_BOOK.armable(alarmKeys[i])) revert BadConfiguration();
            for (uint256 j; j < i; j++) {
                if (alarmKeys[j] == alarmKeys[i]) revert BadConfiguration();
            }
            _keys.push(alarmKeys[i]);
        }
        remainingBudget = budget;
        withdrawShareBps = withdrawBps;
        expiresAt = expiry;
        active = true;
        emit Armed(budget, withdrawBps, expiry, alarmKeys);
    }

    function disarm() external onlyOwner nonReentrant {
        active = false;
        remainingBudget = 0;
        emit Disarmed();
    }

    function repay(uint256 requested, bytes32 alarmKey)
        external
        nonReentrant
        returns (uint256 paid, uint256 collateralPaid)
    {
        if (!active || block.timestamp >= expiresAt || remainingBudget == 0 || requested == 0) {
            revert NotArmed();
        }
        if (msg.sender != OWNER) {
            bool chosen = false;
            for (uint256 i; i < _keys.length; i++) {
                if (_keys[i] == alarmKey) chosen = true;
            }
            if (!chosen || !ALARM_BOOK.isLive(alarmKey, 1 days)) revert NoAlarm();
        }
        MORPHO.accrueInterest(_params);
        IMorphoGuard.Position memory p = MORPHO.position(MARKET_ID, OWNER);
        if (p.borrowShares == 0) revert InvalidRepayment();
        uint256 debt = _debt(p.borrowShares);
        uint256 amount = requested < remainingBudget ? requested : remainingBudget;
        if (amount > debt) amount = debt;
        if (amount == 0) revert InvalidRepayment();
        remainingBudget -= amount;
        uint256 shares;
        (paid, shares) = _fundAndRepay(amount, debt, p.borrowShares);
        // Proportional upper bound: the keeper cannot worsen collateral/debt ratio by taking extra collateral.
        uint256 released = FullMath.mulDiv(p.collateral, shares, p.borrowShares);
        uint256 withdrawAmount = FullMath.mulDiv(released, withdrawShareBps, 10000);
        if (withdrawAmount > 0) {
            try MORPHO.withdrawCollateral(_params, withdrawAmount, OWNER, OWNER) {
                collateralPaid = withdrawAmount;
            } catch { // A failed collateral transfer must not undo a useful repayment.
                emit CollateralHeld(withdrawAmount);
            }
        }
        if (shares == p.borrowShares || remainingBudget == 0) active = false;
        emit Repaid(OWNER, MARKET_ID, paid, shares, collateralPaid);
    }

    function _debt(uint256 borrowShares) private view returns (uint256 debt) {
        IMorphoGuard.Market memory m = MORPHO.market(MARKET_ID);
        uint256 numerator = uint256(m.totalBorrowAssets) + 1;
        uint256 denominator = uint256(m.totalBorrowShares) + 1_000_000;
        debt = FullMath.mulDiv(borrowShares, numerator, denominator);
        if (mulmod(borrowShares, numerator, denominator) > 0) debt++;
    }

    function _fundAndRepay(uint256 amount, uint256 debt, uint256 borrowShares)
        private
        returns (uint256 paid, uint256 shares)
    {
        address token = _params.loanToken;
        uint256 beforeBalance = IERC20(token).balanceOf(address(this));
        SafeTransferLib.safeTransferFrom(token, OWNER, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) != beforeBalance + amount) revert UnsupportedToken();
        if (
            !SafeTransferLib.tryApprove(token, address(MORPHO), 0)
                || !SafeTransferLib.tryApprove(token, address(MORPHO), amount)
        ) revert UnsupportedToken();
        (paid, shares) =
            MORPHO.repay(_params, amount == debt ? 0 : amount, amount == debt ? borrowShares : 0, OWNER, "");
        if (
            paid != amount || shares == 0 || shares > borrowShares
                || IERC20(token).balanceOf(address(this)) != beforeBalance
        ) {
            revert InvalidRepayment();
        }
        if (!SafeTransferLib.tryApprove(token, address(MORPHO), 0)) revert UnsupportedToken();
    }
}
