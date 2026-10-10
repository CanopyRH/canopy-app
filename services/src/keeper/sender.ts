import type { Hex } from "viem";
import type { PlainCall } from "./liquidity";

export interface Fees { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

export interface SendDeps {
  pendingNonce(): Promise<number>;
  fees(): Promise<Fees>;
  send(tx: PlainCall, nonce: number, fees: Fees): Promise<Hex>;
  receipt(hash: Hex): Promise<{ status: string } | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const BUMP = 125n; // Nodes want at least 10% more to replace a transaction.

/** An estimate can fall short by the time a transaction lands: a vault touched in the last block costs less than one that must accrue interest first. Unused gas isn't charged. */
export const withMargin = (gas: bigint) => (gas * 13n) / 10n;
const bump = (x: bigint, n: number) => (x * BUMP ** BigInt(n)) / 100n ** BigInt(n);

/**
 * One key sends one transaction at a time, so loops can't race for a nonce. A transaction that doesn't land is replaced
 * on the same nonce at a higher fee, because a stuck one would hold up every exit behind it.
 */
export function serialSender(d: SendDeps, tries = 4, waitMs = 15_000, pollMs = 500) {
  const once = async (tx: PlainCall): Promise<Hex> => {
    const nonce = await d.pendingNonce();
    const base = await d.fees();
    const hashes: Hex[] = [];
    for (let i = 0; i < tries; i++) {
      try {
        hashes.push(await d.send(tx, nonce, { maxFeePerGas: bump(base.maxFeePerGas, i), maxPriorityFeePerGas: bump(base.maxPriorityFeePerGas, i) }));
      } catch (e) {
        if (hashes.length === 0) throw e; // An earlier try may have landed, which also refuses a replacement.
      }
      const end = d.now() + waitMs;
      while (d.now() < end) {
        for (const h of hashes) {
          const r = await d.receipt(h);
          if (!r) continue;
          if (r.status !== "success") throw new Error(`reverted: ${h}`);
          return h;
        }
        await d.sleep(pollMs);
      }
    }
    throw new Error(`stuck at nonce ${nonce}`);
  };
  let tail: Promise<unknown> = Promise.resolve();
  return (tx: PlainCall): Promise<Hex> => {
    const run = tail.then(() => once(tx));
    tail = run.catch(() => {});
    return run;
  };
}
