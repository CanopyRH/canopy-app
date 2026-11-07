# Borrow Guard audit candidate

One immutable owner, one Morpho Blue market, one AlarmBook. The owner arms a finite repayment budget,
an expiry and up to eight clear keys. A keeper needs a selected live alarm; the owner may repay manually.
The guard accrues interest, caps repayment by the remaining budget and debt, and uses an exact temporary
loan-token allowance. It cannot borrow, transfer to a keeper, select another market, swap or make arbitrary calls.

By default it keeps collateral deposited, reducing LTV. An optional owner-chosen fraction withdraws at
most the proportion of collateral released by the repaid debt shares, always to the owner. Choosing 100%
preserves approximately the previous collateral/debt ratio rather than targeting a lower LTV. If collateral
withdrawal fails, the repayment still succeeds and collateral stays on Morpho. Full repayment or budget
exhaustion deactivates the guard. The owner can disarm and revoke allowances/authorization independently.

This is the allowance-funded fallback from the proposal, not the flash-loan unwind or an LTV-target optimizer.
It does not sell into a weekend gap. It does not guess oracle freshness from Morpho's price() call.

**Not deployed or audited.** Morpho authorizes operators across the owner's entire account; the scope is
restricted by this contract's immutable code, not by Morpho's permission grant. Required before production:
external audit, a pinned verified Morpho deployment, fork tests against actual loan/collateral tokens and
reentrancy/malicious dependency review. Nonstandard fee/rebasing tokens are unsupported.

Interface reference checked 2026-11-06:
https://github.com/morpho-org/morpho-blue/blob/main/src/interfaces/IMorpho.sol
