import type { Repo } from "../store/repo";
import { txUrl } from "../chain/addresses";

/**
 * The large-outflow alert. An exit pays the owner, so a big payout is not an error, but a person should hear about it:
 * it is the first sign of a drain, or of a hostile vault paying out more than a position should hold. Two checks, both on
 * the stablecoin the router pays (its STABLE, 6 decimals): one exit's payouts, and one vault's exits within an hour.
 */
export const STABLE_DECIMALS = 6;
export const OUTFLOW_WINDOW_SEC = 3_600;

export interface OutflowWatch {
  chainId: number;
  /** The router's stablecoin, lowercase. */
  stable: string;
  /** In the stablecoin's smallest units. 0 turns the alert off. */
  threshold: bigint;
  /** The timestamp of a block, in seconds. */
  blockTime: (block: bigint) => Promise<number>;
  /** Queues an operator message under an id, so a replayed log queues one. */
  alert: (id: string, text: string) => Promise<unknown>;
}

/** Whole stablecoin units (what OUTFLOW_ALERT says) as smallest units. */
export const outflowThreshold = (units: number) => BigInt(Math.round(units * 10 ** STABLE_DECIMALS));

/** 1234567890 as "1,234.57". */
export function money(amount: bigint): string {
  const scale = 10n ** BigInt(STABLE_DECIMALS - 2);
  const cents = (amount + scale / 2n) / scale;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** After a `Paid` log was recorded: whether this exit's payouts so far are over the limit. */
export async function checkExitOutflow(r: Repo, w: OutflowWatch, p: { exitId: bigint; tx: string }) {
  if (w.threshold <= 0n) return;
  const total = await r.stablePaidForExit(p.exitId, w.stable);
  if (total <= w.threshold) return;
  const link = txUrl(w.chainId, p.tx);
  await w.alert(
    `outflow:exit:${p.exitId}:${p.tx}`,
    [
      `Canopy ops: one exit paid out ${money(total)} of the stablecoin, over the ${money(w.threshold)} limit (exit ${p.exitId}).`,
      link ? `Transaction: ${link}` : `Transaction: ${p.tx}`,
      "If nobody expected an exit this size, check the vault and follow INCIDENT.md.",
    ].join("\n"),
  );
}

/** After an `Exited` log was recorded with its time: whether the vault's exits in the last hour are over the limit. */
export async function checkVaultOutflow(r: Repo, w: OutflowWatch, e: { posId: string; tx: string; at: number }) {
  if (w.threshold <= 0n) return;
  const vault = await r.targetOf(e.posId);
  if (!vault) return;
  const total = await r.stablePaidByVaultSince(vault, w.stable, e.at - OUTFLOW_WINDOW_SEC);
  if (total <= w.threshold) return;
  const link = txUrl(w.chainId, e.tx);
  await w.alert(
    // One per vault per clock hour, so a drain that keeps going reads as a few messages, not one per exit.
    `outflow:vault:${vault}:${Math.floor(e.at / OUTFLOW_WINDOW_SEC)}`,
    [
      `Canopy ops: exits from vault ${vault} paid out ${money(total)} of the stablecoin within an hour, over the ${money(w.threshold)} limit.`,
      link ? `Latest transaction: ${link}` : `Latest transaction: ${e.tx}`,
      "If nobody expected this, check the vault and follow INCIDENT.md.",
    ].join("\n"),
  );
}
