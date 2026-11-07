import { z } from "zod";
import type { Db } from "../store/db";
export const CreditEntry = z.strictObject({
  id: z.string().min(1).max(180),
  chainId: z.number().int().positive(),
  wallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((s) => s.toLowerCase()),
  delta: z
    .bigint()
    .refine((n) => n !== 0n && n > -(2n ** 255n) && n < 2n ** 255n),
  reason: z.enum(["settled-payment", "usage", "refund", "reorg-reversal"]),
  termsRevision: z.string().min(1).max(120),
  evidence: z.string().min(1).max(256),
  at: z.number().int().nonnegative(),
});
/** Internal accounting only. Caller must verify settlement/finality and terms consent; there is no public credit API. */
export async function applyCredit(
  db: Db,
  input: z.input<typeof CreditEntry>,
): Promise<{ balance: bigint; duplicate: boolean }> {
  const e = CreditEntry.parse(input);
  if (
    (e.reason === "settled-payment" || e.reason === "refund") !==
    e.delta > 0n
  )
    throw new Error("Credit direction does not match reason");
  if (!db.transaction)
    throw new Error("Credit accounting requires real database transactions");
  return db.transaction(async (q) => {
    await q.query(
      "INSERT INTO credit_accounts(chain_id,wallet) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [e.chainId, e.wallet],
    );
    const [account] = await q.query<{ balance: string }>(
      "SELECT balance FROM credit_accounts WHERE chain_id=$1 AND wallet=$2 FOR UPDATE",
      [e.chainId, e.wallet],
    );
    if (!account) throw new Error("Missing credit account");
    const existing = await q.query<{
      chain_id: string;
      wallet: string;
      delta: string;
      reason: string;
      terms_revision: string;
      evidence: string;
      balance_after: string;
    }>("SELECT * FROM credit_entries WHERE id=$1", [e.id]);
    if (existing[0]) {
      const old = existing[0];
      if (
        Number(old.chain_id) !== e.chainId ||
        old.wallet !== e.wallet ||
        BigInt(old.delta) !== e.delta ||
        old.reason !== e.reason ||
        old.terms_revision !== e.termsRevision ||
        old.evidence !== e.evidence
      )
        throw new Error("Idempotency key reused for a different entry");
      return { balance: BigInt(old.balance_after), duplicate: true };
    }
    const balance = BigInt(account.balance) + e.delta;
    if (balance < 0n) throw new Error("Insufficient credit");
    await q.query(
      "INSERT INTO credit_entries(id,chain_id,wallet,delta,balance_after,reason,terms_revision,evidence,at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        e.id,
        e.chainId,
        e.wallet,
        e.delta.toString(),
        balance.toString(),
        e.reason,
        e.termsRevision,
        e.evidence,
        e.at,
      ],
    );
    await q.query(
      "UPDATE credit_accounts SET balance=$3 WHERE chain_id=$1 AND wallet=$2",
      [e.chainId, e.wallet, balance.toString()],
    );
    return { balance, duplicate: false };
  });
}
export type MeteredAction = "check-health" | "arm" | "tighten" | "exit";
/** Proposed USDG rates in six-decimal units. No deduction is enabled by quoting. Owner exits always quote zero. */
export function agentQuote(action: MeteredAction): bigint {
  return action === "exit" ? 0n : action === "check-health" ? 10_000n : 50_000n;
}
export function swapQuote(swappedUnits: bigint): bigint {
  if (swappedUnits < 0n) throw new Error("Negative notional");
  return (swappedUnits * 10n) / 10000n;
}
export function perpQuote(notionalUnits: bigint): bigint {
  if (notionalUnits < 0n) throw new Error("Negative notional");
  return (notionalUnits * 2n) / 10000n;
}
