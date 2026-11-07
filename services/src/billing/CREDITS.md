# Proposed usage credits

The new ledger is separate from existing 90/365-day plan entitlements. It uses database transactions,
wallet row locks, unique event IDs, exact integer units and nonnegative balances. An idempotency key
cannot be reused for another account, amount, reason, terms revision or settlement evidence.

No live deductions, new prices, x402 endpoint or conversion of old plan payments is enabled. Quotes
implement the PDF's proposed 0.01/0.05 USDG agent rates, 10 bps swap rate and 2 bps perp-close rate.
Owner exits quote zero. Charges never come out of the router payout.

Before enabling: select the supported x402 settlement network/asset/facilitator, verify on-chain settlement
and finality, obtain explicit acceptance of a versioned price schedule, and bind the charged request to
the verified payer. Call applyCredit only from that trusted settlement/usage path. A peer's claim of payment
is not evidence. Use a globally unique chain/transaction/log event ID for payments. Reorg reversals that
would make a spent balance negative must be held for reconciliation, not silently ignored or used to block
owner exits. Refunds need a unique charge-linked event. Existing time-plan transfer indexing stays unchanged.
