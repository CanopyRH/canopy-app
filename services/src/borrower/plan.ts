import { z } from "zod";
import { WAD, type BorrowPosition } from "./morpho";
import { sessionState, type Calendar } from "../rwa/session";
const bps = z.number().int().min(0).max(10000);
export const BorrowPolicy = z
  .strictObject({
    triggerLtvBps: bps,
    targetLtvBps: bps,
    sessionTargetLtvBps: bps,
    preCloseSeconds: z.number().int().min(0).max(86400),
    maxObservationAge: z.number().int().min(1).max(60),
  })
  .refine(
    (p) =>
      p.targetLtvBps < p.triggerLtvBps &&
      p.sessionTargetLtvBps <= p.targetLtvBps,
    "Targets must be below the trigger",
  );
export function planBorrowRepayment(
  position: BorrowPosition,
  policy: z.infer<typeof BorrowPolicy>,
  guard: {
    active: boolean;
    expiresAt: number;
    withdrawShareBps: number;
    remainingBudget: bigint;
    allowance: bigint;
    balance: bigint;
    alarmLive: boolean;
  },
  now: number,
  session?: {
    calendar: Calendar;
    feed: Parameters<typeof sessionState>[3];
    multiplierChanged: boolean;
  },
) {
  BorrowPolicy.parse(policy);
  if (
    !Number.isSafeInteger(now) ||
    position.observedAt > now ||
    now - position.observedAt > policy.maxObservationAge
  )
    throw new Error("Stale borrower observation");
  for (const n of [
    guard.remainingBudget,
    guard.allowance,
    guard.balance,
    position.debt,
    position.collateralValue,
  ])
    if (n < 0n) throw new Error("Negative borrower amount");
  if ((BigInt(policy.triggerLtvBps) * WAD) / 10000n >= position.lltv)
    throw new Error("Trigger must precede liquidation");
  const s = session
    ? sessionState(
        session.calendar,
        now,
        policy.preCloseSeconds,
        session.feed,
        session.multiplierChanged,
      )
    : null;
  const preClose = s?.preClose === true;
  const triggered =
    position.ltv !== null &&
    position.ltv * 10000n >= BigInt(policy.triggerLtvBps) * WAD;
  if (!guard.active || now >= guard.expiresAt)
    return {
      action: "hold" as const,
      reason: "guard-inactive",
      allowSwap: false,
    };
  if (guard.withdrawShareBps !== 0)
    return {
      action: "hold" as const,
      reason: "target-LTV-requires-retained-collateral",
      allowSwap: false,
    };
  if (position.debt === 0n)
    return { action: "none" as const, reason: "no-debt", allowSwap: false };
  if (!guard.alarmLive)
    return {
      action: "hold" as const,
      reason: "no-owner-selected-live-alarm",
      allowSwap: false,
    };
  // With unknown pricing we can still reduce debt from the approved allowance, but cannot claim a target LTV.
  const defensive = !position.priceUsable || s?.allowSwap === false;
  if (!triggered && !preClose && !defensive)
    return {
      action: "none" as const,
      reason: "below-trigger",
      allowSwap: !!s?.allowSwap,
    };
  const targetBps = preClose ? policy.sessionTargetLtvBps : policy.targetLtvBps;
  const targetDebt = defensive
    ? 0n
    : (position.collateralValue * BigInt(targetBps)) / 10000n;
  const wanted = position.debt > targetDebt ? position.debt - targetDebt : 0n;
  if (wanted === 0n)
    return {
      action: "none" as const,
      reason: "already-at-target",
      allowSwap: !!s?.allowSwap,
    };
  // One-unit cushion for the debt-share round-down on asset-denominated partial repayment.
  const requested = [
    wanted + 1n,
    position.debt,
    guard.remainingBudget,
    guard.allowance,
    guard.balance,
  ].reduce((a, b) => (a < b ? a : b));
  if (requested === 0n)
    return {
      action: "hold" as const,
      reason: "no-approved-funding",
      allowSwap: false,
    };
  return {
    action: "repay" as const,
    requested,
    desired: wanted,
    capped: requested < wanted,
    targetLtvBps: position.priceUsable && !defensive ? targetBps : null,
    reason: defensive
      ? "defensive-allowance-repayment"
      : preClose
        ? "session-preclose"
        : "ltv-trigger",
    allowSwap: false,
  };
}
