import { decodeEventLog, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";
import { alarmBookAbi, erc20Abi, routerAbi } from "../chain/abi";
import { daysFor, extendPlan } from "../billing/prepaid";
import type { Db } from "../store/db";
import type { Repo } from "../store/repo";
import { adminEventOf, type AdminEvent } from "./admin";
import { backoffSec, cleanError, fromStored, RETRY_BASE_SEC, RETRY_MAX_SEC, STUCK_AFTER_SEC, subjectOf, toStored, type RetryTuning, type StuckLog } from "./retry";

const lc = (a: string) => a.toLowerCase();

export interface Log {
  address: Address;
  data: Hex;
  topics: [Hex, ...Hex[]] | [];
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
}

/**
 * Applies one router log. Safe to replay: every write is an upsert.
 * `onAdmin` hears about admin and guardian changes. It should only queue work, so reading logs never waits on a message.
 */
export async function applyRouterLog(r: Repo, log: Log, onAdmin?: (e: AdminEvent) => Promise<unknown>) {
  const admin = onAdmin ? adminEventOf("ExitRouter", log) : null;
  if (admin) return void (await onAdmin!(admin));
  const ev = decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics as never, strict: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = ev.args as unknown as Record<string, any>;
  switch (ev.eventName) {
    case "Armed": {
      const owner = lc(a.owner as string);
      await r.upsertPosition({
        posId: a.posId, owner, adapter: lc(a.adapter as string), target: lc(a.target as string), tokenId: a.tokenId,
        harbour: Number(a.harbour), maxSlipBps: Number(a.maxSlipBps), epoch: await r.epochOf(owner), block: log.blockNumber ?? 0n,
        termsHash: a.termsHash, keys: a.keys as readonly string[],
      });
      break;
    }
    case "Disarmed":
      await r.disarm(a.posId);
      break;
    case "DisarmedAll":
      await r.disarmAll(lc(a.owner as string), BigInt(a.newEpoch));
      break;
    case "Exited":
      await r.recordExit({
        exitId: a.exitId, posId: a.posId, owner: lc(a.owner as string), caller: lc(a.caller as string), alarmKey: a.alarmKey, viaAlarm: a.viaAlarm,
        tx: log.transactionHash!, block: log.blockNumber ?? 0n,
      });
      break;
    case "Paid":
      await r.recordPayout({ exitId: a.exitId, tx: log.transactionHash!, logIndex: log.logIndex!, token: lc(a.token as string), amount: a.amount, swapped: a.swapped });
      break;
    case "Owed":
      await r.addOwed(log.transactionHash!, log.logIndex!, lc(a.owner as string), lc(a.token as string), a.amount);
      break;
    case "OwedClaimed":
      await r.clearOwed(lc(a.owner as string), lc(a.token as string));
      break;
  }
}

/** Credits exact plan payments. Anything else stays uncredited for manual review. Replays credit nothing twice. */
export async function applyPayment(r: Repo, log: Log, now: number) {
  const ev = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics: log.topics as never });
  const wallet = lc(ev.args.from);
  const days = daysFor(ev.args.value);
  const fresh = await r.recordPayment({
    tx: log.transactionHash!, logIndex: log.logIndex!, wallet, amount: ev.args.value, credited: days !== null, at: now,
  });
  if (fresh) await r.applyPayment(log.transactionHash!, log.logIndex!, wallet, days === null ? null : extendPlan(await r.paidUntil(wallet), days, now));
  return { wallet, days, fresh };
}

export interface FiredAlarm { key: Hex; target: Address; evidence: Hex; tx: Hex | null }

/** Records a detector so the watcher knows which quorum keys exist. Returns null for other events. */
export async function applyRegistered(db: Db, log: Log): Promise<boolean> {
  const ev = decodeEventLog({ abi: alarmBookAbi, data: log.data, topics: log.topics as never, strict: false });
  if (ev.eventName !== "Registered") return false;
  const a = ev.args as unknown as { key: Hex; kind: number; target: Address; threshold: bigint; window: number; a: Hex; b: Hex };
  await db.query(
    `INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [a.key, a.kind, a.target.toLowerCase(), a.threshold.toString(), a.window, a.a, a.b],
  );
  return true;
}

/** Hands an AlarmBook admin event, such as a watcher being allowed or removed, to `onAdmin`. Returns whether the log was one. */
export async function applyAlarmAdmin(log: Log, onAdmin: (e: AdminEvent) => Promise<unknown>): Promise<boolean> {
  const admin = adminEventOf("AlarmBook", log);
  if (!admin) return false;
  await onAdmin(admin);
  return true;
}

export function decodeFired(log: Log): FiredAlarm | null {
  const ev = decodeEventLog({ abi: alarmBookAbi, data: log.data, topics: log.topics as never, strict: false });
  if (ev.eventName !== "Fired") return null;
  const a = ev.args as { key: Hex; target: Address; evidence: Hex };
  return { key: a.key, target: a.target, evidence: a.evidence, tx: log.transactionHash };
}

export interface SyncOptions {
  name: string;
  address: Address | Address[];
  startBlock: bigint;
  step?: bigint;
  /** Narrows a busy contract, such as plan payments on the stablecoin. */
  filter?: { event: AbiEvent; args: Record<string, unknown> };
  onLog: (l: Log) => Promise<void>;
  /** Called once for a log that has been failing for a while. It should only queue a message. */
  onStuck?: (s: StuckLog) => Promise<unknown>;
  /** Seconds. Defaults to the clock. */
  now?: () => number;
  /** Overrides the retry timing, for tests. */
  retry?: Partial<RetryTuning>;
}

/**
 * Reads logs from the saved cursor in small ranges, so a restart resumes where it stopped.
 *
 * A log that fails is never dropped. It goes on a durable retry list in the database, the cursor moves past it, and the
 * logs after it still land. Each pass retries the due ones, waiting longer after every failure. Logs about the same thing
 * (the same position, owner or key) stay in order, so one waits behind an earlier failed one. A log that keeps failing is
 * reported through `onStuck`. This matters because registering a detector is open to anyone, so one bad log must never
 * stop the indexer, and a pruned or lagging node must never cost an alarm's exits.
 */
export async function syncLogs(client: Pick<PublicClient, "getBlockNumber" | "getLogs">, r: Repo, opts: SyncOptions) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const tune: RetryTuning = { baseSec: RETRY_BASE_SEC, maxSec: RETRY_MAX_SEC, stuckAfterSec: STUCK_AFTER_SEC, ...opts.retry };
  await retryParked(r, opts, now, tune);

  const tip = await client.getBlockNumber();
  const step = opts.step ?? 2_000n;
  let from = (await r.cursor(opts.name)) ?? opts.startBlock;
  const waiting = new Set((await r.parkedLogs(opts.name)).map((p) => p.subject).filter(Boolean));
  while (from <= tip) {
    const to = from + step - 1n > tip ? tip : from + step - 1n;
    const logs = (await client.getLogs({ address: opts.address, fromBlock: from, toBlock: to, ...opts.filter } as never)) as unknown as Log[];
    for (const l of logs) {
      const subject = subjectOf(l);
      if (subject && waiting.has(subject)) {
        await park(r, opts, l, now(), new Error("waiting behind an earlier log about the same thing"), tune);
        continue;
      }
      try {
        await opts.onLog(l);
      } catch (e) {
        await park(r, opts, l, now(), e, tune);
        if (subject) waiting.add(subject);
      }
    }
    await r.setCursor(opts.name, to + 1n);
    from = to + 1n;
  }
  await reportStuck(r, opts, now(), tune);
  return tip;
}

async function park(r: Repo, opts: SyncOptions, l: Log, at: number, error: unknown, tune: RetryTuning) {
  console.warn("log parked for retry", opts.name, `${l.transactionHash}:${l.logIndex}`, cleanError(error));
  await r.bump("log_parked");
  await r.parkLog({
    source: opts.name, tx: l.transactionHash!, logIndex: l.logIndex!, subject: subjectOf(l), block: l.blockNumber ?? 0n, log: toStored(l), now: at,
    nextAt: at + backoffSec(0, tune.baseSec, tune.maxSec), error: cleanError(error),
  });
}

/** Retries the parked logs that are due, oldest first. A log that still fails keeps every later log about the same thing waiting. */
async function retryParked(r: Repo, opts: SyncOptions, now: () => number, tune: RetryTuning) {
  const blocked = new Set<string>();
  for (const p of await r.parkedLogs(opts.name)) {
    if (p.subject && blocked.has(p.subject)) continue;
    if (p.next_at > now()) {
      if (p.subject) blocked.add(p.subject);
      continue;
    }
    try {
      await opts.onLog(fromStored(p.log) as Log);
      await r.logRetried(opts.name, p.tx, p.log_index);
      await r.bump("log_recovered");
    } catch (e) {
      if (p.subject) blocked.add(p.subject);
      await r.logRetryFailed(opts.name, p.tx, p.log_index, now() + backoffSec(p.attempts + 1, tune.baseSec, tune.maxSec), cleanError(e));
    }
  }
}

/** Tells the operator once about each log that has been failing for a while. */
async function reportStuck(r: Repo, opts: SyncOptions, at: number, tune: RetryTuning) {
  if (!opts.onStuck) return;
  for (const p of await r.parkedLogs(opts.name)) {
    if (p.alerted || at - p.first_failed_at < tune.stuckAfterSec) continue;
    try {
      await opts.onStuck({ source: opts.name, tx: p.tx, logIndex: p.log_index, block: BigInt((p.log as { blockNumber?: string | null }).blockNumber ?? 0), attempts: p.attempts, sinceSec: at - p.first_failed_at, error: p.last_error });
      await r.logRetryAlerted(opts.name, p.tx, p.log_index);
    } catch (e) {
      console.warn("stuck log alert", cleanError(e));
    }
  }
}
