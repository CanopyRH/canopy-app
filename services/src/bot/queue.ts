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

/** Runs the due jobs of one kind. A failed send is retried later, and dropped after `tries`. */
async function drain(r: Repo, kind: string, tries: number, now: () => number, send: (payload: unknown) => Promise<unknown>) {
  for (const job of await r.dueJobs(kind, now())) {
    try {
      await send(job.payload);
      await r.finishJob(job.id);
    } catch (e) {
      console.warn(kind, (e as Error).message);
      if (job.attempts + 1 >= tries) await r.finishJob(job.id);
      else await r.retryJob(job.id, now() + ALERT_RETRY_SEC);
    }
  }
}

/** Sends queued alerts. Runs on its own timer, so the loop that reads alarms never waits on Telegram. */
export function sendQueuedAlerts(r: Repo, send: (vault: string, text: string) => Promise<unknown>, now: () => number) {
  return drain(r, "alert", ALERT_TRIES, now, (p) => send((p as QueuedAlert).vault, (p as QueuedAlert).text));
}

/** Operator warnings get many more tries than follower alerts, about ten minutes' worth. */
export const OPS_TRIES = 20;

/** Queues one message for the operator chat. The same id is only queued once, so a replayed log warns once. */
export function queueOps(r: Repo, id: string, text: string, now: number) {
  return r.enqueue("ops", `ops:${id}`, { text }, now);
}

/** Sends queued operator messages from their own timer, so the indexer only ever writes a row. */
export function sendQueuedOps(r: Repo, send: (text: string) => Promise<unknown>, now: () => number) {
  return drain(r, "ops", OPS_TRIES, now, (p) => send((p as { text: string }).text));
}
