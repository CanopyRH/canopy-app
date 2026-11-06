import type { Address } from "viem";
import { signalLine, watchAlert } from "../copy/alerts";
import { scanVault, type ScanDeps } from "./scan";

/** How long one vault's scan may take before the loop moves on. Anyone can follow a contract built to answer slowly. */
export const SCAN_BUDGET_MS = 10_000;

export interface ScanLoopDeps extends ScanDeps {
  /** Queues an alert for a vault's followers. `tag` makes it a new alert even if the text repeats an older one. */
  queue: (vault: string, text: string, tag: string) => Promise<unknown>;
  vaultName: (vault: string) => Promise<string>;
  withdrawInRobinhoodApp: boolean;
  /** Overrides SCAN_BUDGET_MS, for tests. */
  budgetMs?: number;
}

/** Resolves to `p`, or rejects after `ms`. The work itself goes on, but nothing waits for it. */
export async function withinMs<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} over the ${ms} ms budget`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scans each vault in turn, each within its own time budget, and queues what followers should hear. Sending is left
 * to the alerts loop, so a slow or rate-limited Telegram never holds up the next vault's scan.
 */
export async function scanAll(d: ScanLoopDeps, targets: readonly string[]) {
  const budget = d.budgetMs ?? SCAN_BUDGET_MS;
  for (const target of targets) {
    try {
      for (const s of await withinMs(scanVault(d, target as Address), budget, "scan")) {
        const now = d.now();
        if (!(await d.repo.claimAlert(target, s.kind, now))) continue;
        const text = watchAlert({ vaultName: await d.vaultName(target), what: signalLine(s.kind, s.value), withdrawInRobinhoodApp: d.withdrawInRobinhoodApp });
        await d.queue(target, text, `${s.kind}:${now}`);
      }
    } catch (e) {
      console.error("scan", target, (e as Error).message);
    }
  }
}
