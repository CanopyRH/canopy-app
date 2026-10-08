const DAY = 86_400;
const UNIT = 1_000_000n; // plan stablecoins use 6 decimals

export const PLANS = [
  { amount: 15n * UNIT, days: 90 },
  { amount: 60n * UNIT, days: 365 },
] as const;

/** Days bought by an exact payment. Partial or unknown amounts return null and go to manual review. */
export function daysFor(amount: bigint): number | null {
  return PLANS.find((p) => p.amount === amount)?.days ?? null;
}

/** New paid_until in unix seconds. Early renewals extend from the current end date. */
export function extendPlan(paidUntil: number | null, days: number, now: number): number {
  const base = paidUntil !== null && paidUntil > now ? paidUntil : now;
  return base + days * DAY;
}

/** Only Canopy's own keeper applies this. No contract reads it, so exits stay open to everyone else. */
export function keeperShouldRun(paidUntil: number | null, now: number): boolean {
  return paidUntil !== null && paidUntil > now;
}
