import { test, expect } from "bun:test";
import { accruedDebt, WAD, type BorrowPosition } from "../src/borrower/morpho";
import { planBorrowRepayment } from "../src/borrower/plan";
const position = {
  debt: 750n,
  collateralValue: 1000n,
  ltv: (75n * WAD) / 100n,
  lltv: (8n * WAD) / 10n,
  observedAt: 1000,
  priceUsable: true,
} as BorrowPosition;
const policy = {
  triggerLtvBps: 7000,
  targetLtvBps: 6000,
  sessionTargetLtvBps: 4000,
  preCloseSeconds: 600,
  maxObservationAge: 30,
};
const guard = {
  active: true,
  expiresAt: 2000,
  withdrawShareBps: 0,
  remainingBudget: 1000n,
  allowance: 1000n,
  balance: 1000n,
  alarmLive: true,
};
test("borrower planning retains collateral, honors funding caps and requires a live owner-selected alarm", () => {
  expect(planBorrowRepayment(position, policy, guard, 1001)).toMatchObject({
    action: "repay",
    requested: 151n,
    desired: 150n,
    capped: false,
    targetLtvBps: 6000,
    allowSwap: false,
  });
  expect(
    planBorrowRepayment(position, policy, { ...guard, balance: 100n }, 1001),
  ).toMatchObject({ requested: 100n, capped: true });
  expect(
    planBorrowRepayment(position, policy, { ...guard, alarmLive: false }, 1001)
      .action,
  ).toBe("hold");
  expect(
    planBorrowRepayment(
      position,
      policy,
      { ...guard, withdrawShareBps: 10000 },
      1001,
    ).action,
  ).toBe("hold");
  expect(() => planBorrowRepayment(position, policy, guard, 1031)).toThrow();
  expect(() =>
    planBorrowRepayment(
      position,
      { ...policy, triggerLtvBps: 8000 },
      guard,
      1001,
    ),
  ).toThrow();
});
test("preclose targets and unknown pricing use capped allowance without suggesting a swap", () => {
  const session = {
    calendar: {
      source: "https://example.org/calendar",
      reviewedAt: 800,
      validFrom: 900,
      validUntil: 3000,
      windows: [{ open: 900, close: 1500 }],
    },
    feed: { updatedAt: 1000, heartbeat: 60, positive: true, paused: false },
    multiplierChanged: false,
  };
  expect(
    planBorrowRepayment(position, policy, guard, 1001, session),
  ).toMatchObject({
    reason: "session-preclose",
    requested: 351n,
    targetLtvBps: 4000,
  });
  expect(
    planBorrowRepayment(
      { ...position, priceUsable: false, ltv: null },
      policy,
      guard,
      1001,
      session,
    ),
  ).toMatchObject({
    reason: "defensive-allowance-repayment",
    requested: 750n,
    targetLtvBps: null,
    allowSwap: false,
  });
  expect(
    planBorrowRepayment(position, policy, guard, 1001, {
      ...session,
      multiplierChanged: true,
    }),
  ).toMatchObject({
    reason: "defensive-allowance-repayment",
    allowSwap: false,
  });
});
test("expected interest matches integer Morpho arithmetic and never treats an ancient market as current", () => {
  expect(accruedDebt(600_000_000n, 600n, 600_000_000n, 0n, 1n)).toBe(600n);
  expect(
    accruedDebt(600_000_000n, 600n, 600_000_000n, 10n ** 14n, 1000n),
  ).toBeGreaterThan(600n);
  expect(() => accruedDebt(1n, 1n, 1n, 0n, 366n * 86400n)).toThrow();
});
