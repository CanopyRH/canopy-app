import { createHash } from "node:crypto";
import type { Repo } from "../store/repo";

/** Tries per alert before it is dropped. Sending already skips chats that fail, so this is for Telegram itself being down. */
export const ALERT_TRIES = 5;
export const ALERT_RETRY_SEC = 30;

export interface QueuedAlert { vault: string; text: string }

/** Queues one alert for a vault's followers. The same text for the same vault is only queued once. */
export function queueAlert(r: Repo, vault: string, text: string, now: number) {
  const dedupe = `alert:${createHash("sha256").update(`${vault.toLowerCase()}\n${text}`).digest("hex")}`;
  return r.enqueue("alert", dedupe, { vault, text } satisfies QueuedAlert, now);
}

/** Sends queued alerts. Runs on its own timer, so the loop that reads alarms never waits on Telegram. */
export async function sendQueuedAlerts(r: Repo, send: (vault: string, text: string) => Promise<unknown>, now: () => number) {
  for (const job of await r.dueJobs("alert", now())) {
    const a = job.payload as QueuedAlert;
    try {
      await send(a.vault, a.text);
      await r.finishJob(job.id);
    } catch (e) {
      console.warn("alert", (e as Error).message);
      if (job.attempts + 1 >= ALERT_TRIES) await r.finishJob(job.id);
      else await r.retryJob(job.id, now() + ALERT_RETRY_SEC);
    }
  }
}
