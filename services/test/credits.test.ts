import { beforeEach, test, expect } from "bun:test";
import { freshDb } from "./db";
import {
  applyCredit,
  agentQuote,
  swapQuote,
  perpQuote,
} from "../src/billing/credits";
import type { Db } from "../src/store/db";
let db: Db;
beforeEach(async () => {
  db = await freshDb();
});
const wallet = "0x0000000000000000000000000000000000000001";
const credit = {
  id: "payment:4663:example:0",
  chainId: 4663,
  wallet,
  delta: 1000000n,
  reason: "settled-payment" as const,
  termsRevision: "proposed-v1",
  evidence: "verified-receipt-fixture",
  at: 1,
};
test("credit entries are idempotent and conflicting reuse is refused", async () => {
  expect(await applyCredit(db, credit)).toEqual({
    balance: 1000000n,
    duplicate: false,
  });
  expect(await applyCredit(db, credit)).toEqual({
    balance: 1000000n,
    duplicate: true,
  });
  await expect(
    applyCredit(db, { ...credit, delta: 2000000n }),
  ).rejects.toThrow();
  await expect(
    applyCredit(db, {
      ...credit,
      wallet: "0x0000000000000000000000000000000000000002",
    }),
  ).rejects.toThrow();
});
test("simultaneous debits cannot overdraw and failed entries leave no charge", async () => {
  await applyCredit(db, credit);
  const results = await Promise.allSettled(
    [1, 2].map((n) =>
      applyCredit(db, {
        ...credit,
        id: `usage-${n}`,
        delta: -600000n,
        reason: "usage",
      }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const [balance] = await db.query<{ balance: string }>(
    "SELECT balance FROM credit_accounts WHERE wallet=$1",
    [wallet],
  );
  expect(BigInt(balance!.balance)).toBe(400000n);
  const entries = await db.query("SELECT * FROM credit_entries");
  expect(entries).toHaveLength(2);
});
test("quotes preserve free exits and do not turn time plans into credit", () => {
  expect(agentQuote("exit")).toBe(0n);
  expect(agentQuote("check-health")).toBe(10000n);
  expect(agentQuote("arm")).toBe(50000n);
  expect(swapQuote(100000000n)).toBe(100000n);
  expect(perpQuote(100000000n)).toBe(20000n);
  expect(() => swapQuote(-1n)).toThrow();
});
