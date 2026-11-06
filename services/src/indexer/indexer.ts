import { decodeEventLog, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";
import { alarmBookAbi, erc20Abi, routerAbi } from "../chain/abi";
import { daysFor, extendPlan } from "../billing/prepaid";
import type { Db } from "../store/db";
import type { Repo } from "../store/repo";
import { adminEventOf, type AdminEvent } from "./admin";
import { checkExitOutflow, checkVaultOutflow, type OutflowWatch } from "./outflow";
import { backoffSec, cleanError, fromStored, RETRY_BASE_SEC, RETRY_MAX_SEC, STUCK_AFTER_SEC, subjectOf, toStored, type RetryTuning, type StuckLog } from "./retry";

const lc = (a: string) => a.toLowerCase();

export interface Log {
  address: Address;
  data: Hex;
  topics: [Hex, ...Hex[]] | [];
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
  /** The hash of the block the log came from. Nodes send it with every log. */
  blockHash?: Hex | null;
}

/**
 * Applies one router log. Safe to replay: every write is an upsert.
 * `onAdmin` hears about admin and guardian changes. It should only queue work, so reading logs never waits on a message.
 * `outflow` turns on the large-outflow alert: a payout or an exit that takes a total over the limit queues an operator message.
 */
export async function applyRouterLog(r: Repo, log: Log, onAdmin?: (e: AdminEvent) => Promise<unknown>, outflow?: OutflowWatch) {
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
    case "SwapLegSet":
      // The router logs a position's legs right after its Armed log. Their exits run token code the owner chose.
      await r.markSwaps(a.posId, true);
      break;
    case "Disarmed":
      await r.disarm(a.posId);
      break;
    case "DisarmedAll":
      await r.disarmAll(lc(a.owner as string), BigInt(a.newEpoch));
      break;
    case "Exited": {
      const at = outflow && log.blockNumber != null ? await outflow.blockTime(log.blockNumber) : undefined;
      await r.recordExit({
        exitId: a.exitId, posId: a.posId, owner: lc(a.owner as string), caller: lc(a.caller as string), alarmKey: a.alarmKey, viaAlarm: a.viaAlarm,
        tx: log.transactionHash!, block: log.blockNumber ?? 0n, at,
      });
      if (outflow && at !== undefined) await checkVaultOutflow(r, outflow, { posId: a.posId, tx: log.transactionHash!, at });
      break;
    }
    case "Paid":
      await r.recordPayout({ exitId: a.exitId, tx: log.transactionHash!, logIndex: log.logIndex!, token: lc(a.token as string), amount: a.amount, swapped: a.swapped, block: log.blockNumber });
      if (outflow && lc(a.token as string) === outflow.stable) await checkExitOutflow(r, outflow, { exitId: a.exitId, tx: log.transactionHash! });
      break;
    case "Owed":
      await r.addOwed(log.transactionHash!, log.logIndex!, lc(a.owner as string), lc(a.token as string), a.amount, log.blockNumber);
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
    tx: log.transactionHash!, logIndex: log.logIndex!, wallet, amount: ev.args.value, credited: days !== null, at: now, block: log.blockNumber,
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
    `INSERT INTO detectors (key, kind, target, threshold, window_s, a, b, block) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [a.key, a.kind, a.target.toLowerCase(), a.threshold.toString(), a.window, a.a, a.b, log.blockNumber == null ? null : log.blockNumber.toString()],
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

/** How many recent blocks per cursor have their hash remembered. A reorg deeper than this can't be walked back exactly. */
export const REORG_WINDOW = 2_000n;

/** What the operator is told when a reorg runs past the remembered window. */
export interface ReorgInfo {
  source: string;
  /** Where the cursor was. */
  cursor: bigint;
  /** Where it was rewound to. */
  rewoundTo: bigint;
  /** True when no remembered block still matched the chain, so the rewind went to the start of the window. */
  beyondWindow: boolean;
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
  /** Blocks to hold back from the head, so a log is only applied once it is this deep. Defaults to none. */
  confirmations?: bigint;
  /** Seconds. Defaults to the clock. */
  now?: () => number;
  /** Overrides the retry timing, for tests. */
  retry?: Partial<RetryTuning>;
  /** On a reorg, undoes what the logs of the dropped blocks (from this block on) wrote. Must be safe to run twice. */
  onRewind?: (from: bigint) => Promise<unknown>;
  /**
   * After a rewind and the re-read, gets everything the dropped blocks' logs were about (a position, an owner, a key), to
   * re-check against the chain at block `at`. If it throws, the list is kept and it is called again on the next pass.
   */
  recheck?: (subjects: string[], at: bigint) => Promise<unknown>;
  /** Called when a reorg ran past the remembered window. It should only queue a message to the operators. */
  onDeepReorg?: (i: ReorgInfo) => Promise<unknown>;
  /** Blocks of hashes to remember. Defaults to REORG_WINDOW. */
  window?: bigint;
  /**
   * Called at the start of a pass and again before each range of logs is applied. It throws when the database no longer
   * belongs to this reader's contracts, so a process on old addresses stops before it writes.
   */
  fence?: () => Promise<void>;
}

type Chain = Pick<PublicClient, "getBlockNumber" | "getLogs"> & Partial<Pick<PublicClient, "getBlock">>;

/** The hash the chain has for a block now, or null if the chain has no such block (it is shorter now). */
async function chainHash(client: Chain, block: bigint): Promise<string | null> {
  try {
    const b = await client.getBlock!({ blockNumber: block });
    return b?.hash ? b.hash.toLowerCase() : null;
  } catch (e) {
    if ((e as Error).name === "BlockNotFoundError") return null;
    throw e;
  }
}

/**
 * Rewinds a reader to `rewoundTo`. Undo first, drop the logs parked from the dropped blocks, then move the cursor, then
 * forget the rest. A crash in between repeats the undo, which is safe; the parked logs are gone before the cursor moves,
 * so a restart can't apply one from a block that no longer exists, and the stale hashes are ignored once the cursor is behind them.
 */
async function rewind(r: Repo, opts: SyncOptions, from: bigint, rewoundTo: bigint, beyondWindow: boolean) {
  await r.queueRecheck(opts.name, rewoundTo);
  await opts.onRewind?.(rewoundTo);
  await r.dropRetries(opts.name, beyondWindow ? 0n : rewoundTo);
  await r.setCursor(opts.name, rewoundTo);
  await r.dropFrom(opts.name, beyondWindow ? 0n : rewoundTo);
  await r.bump("reorgs_handled");
  console.warn("reorg handled", opts.name, `cursor ${from} -> ${rewoundTo}`, beyondWindow ? "(past the remembered window)" : `(${from - rewoundTo} blocks)`);
}

/**
 * Checks that the newest block the indexer has read is still on the chain. If it isn't, finds the newest remembered block
 * that is (a block's hash covers everything before it, so a match means all earlier blocks match too, and a binary search
 * finds it in a few reads) and rewinds the cursor to just after it. Returns where reading should continue.
 */
async function checkReorg(client: Chain, r: Repo, opts: SyncOptions, from: bigint): Promise<bigint> {
  const stored = await r.storedHashes(opts.name, from);
  const last = stored.at(-1);
  if (!last || (await chainHash(client, last.block)) === last.hash) return from;
  let good = -1; // index of the newest block known to match
  let bad = stored.length - 1; // index of the oldest block known not to
  while (bad - good > 1) {
    const mid = (good + bad) >> 1;
    if ((await chainHash(client, stored[mid]!.block)) === stored[mid]!.hash) good = mid;
    else bad = mid;
  }
  const beyondWindow = good < 0;
  // Past everything remembered, the safe choice is the start of the window: nothing older is trusted or kept.
  const windowStart = from - (opts.window ?? REORG_WINDOW);
  const rewoundTo = beyondWindow ? (windowStart > opts.startBlock ? windowStart : opts.startBlock) : stored[good]!.block + 1n;
  await rewind(r, opts, from, rewoundTo, beyondWindow);
  if (beyondWindow && opts.onDeepReorg) {
    try {
      await opts.onDeepReorg({ source: opts.name, cursor: from, rewoundTo, beyondWindow });
    } catch (e) {
      console.warn("reorg alert", cleanError(e));
    }
  }
  return rewoundTo;
}

/**
 * Reads logs from the saved cursor in small ranges, so a restart resumes where it stopped.
 *
 * A log that fails is never dropped. It goes on a durable retry list in the database, the cursor moves past it, and the
 * logs after it still land. Each pass retries the due ones, waiting longer after every failure. Logs about the same thing
 * (the same position, owner or key) stay in order, so one waits behind an earlier failed one. A log that keeps failing is
 * reported through `onStuck`. This matters because registering a detector is open to anyone, so one bad log must never
 * stop the indexer, and a pruned or lagging node must never cost an alarm's exits.
 *
 * Reorgs: the hash of each block read (every block that had a log, and the end of each range) is kept for the last
 * `window` blocks. Before reading, the newest of them is compared with the chain. On a mismatch the cursor is rewound to
 * just after the newest block that still matches, `onRewind` undoes what the dropped blocks wrote, and the range is read
 * again. Once it has caught up, `recheck` re-reads from the chain everything those blocks touched. Without `getBlock` on
 * the client nothing is tracked.
 */
export async function syncLogs(client: Chain, r: Repo, opts: SyncOptions) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const tune: RetryTuning = { baseSec: RETRY_BASE_SEC, maxSec: RETRY_MAX_SEC, stuckAfterSec: STUCK_AFTER_SEC, ...opts.retry };
  const window = opts.window ?? REORG_WINDOW;
  const track = client.getBlock !== undefined;
  await opts.fence?.();
  // Before anything is retried, so logs parked from blocks that are gone are dropped first.
  let from = (await r.cursor(opts.name)) ?? opts.startBlock;
  if (track && from > opts.startBlock) from = await checkReorg(client, r, opts, from);
  await retryParked(r, opts, now, tune, from);

  // With a confirmation depth, the newest blocks are left for the next pass. Nothing before the depth is ever read early.
  const head = await client.getBlockNumber();
  const depth = opts.confirmations ?? 0n;
  const tip = head >= depth ? head - depth : -1n;
  const step = opts.step ?? 2_000n;
  const waiting = new Set((await r.parkedLogs(opts.name)).map((p) => p.subject).filter(Boolean));
  let anchor = true;
  while (from <= tip) {
    const to = from + step - 1n > tip ? tip : from + step - 1n;
    // Only recent blocks are remembered. The end hash is read before the logs, so a reorg in between shows up next pass.
    const remember = track && to + window > tip;
    const endHash = remember ? await chainHash(client, to) : null;
    const logs = (await client.getLogs({ address: opts.address, fromBlock: from, toBlock: to, ...opts.filter } as never)) as unknown as Log[];
    const hashes = new Map<bigint, string>();
    if (endHash) hashes.set(to, endHash);
    // Nothing older is remembered yet (a first run, or the first pass after this was added), so remember the block just
    // before the first range. A reorg right after it then rewinds to here, not to the start of the window.
    if (remember && anchor && from > 0n && !(await r.hasHash(opts.name, from - 1n))) {
      const h = await chainHash(client, from - 1n);
      if (h) hashes.set(from - 1n, h);
    }
    anchor = false;
    await opts.fence?.();
    // Nodes behind a load balancer can answer from different forks. A log whose block hash disagrees with the hash already
    // known for its block (stored, or read for this range) is treated as a reorg: nothing from this range is applied.
    if (remember && (await logsDisagree(client, r, opts.name, logs, hashes))) {
      console.warn("log block hash does not match the chain's", opts.name, `range ${from}-${to}`);
      await rewind(r, opts, from, from, false);
      return tip;
    }
    for (const l of logs) {
      const subject = subjectOf(l);
      if (remember && l.blockNumber != null) {
        if (subject) await r.touch(opts.name, l.blockNumber, subject);
        const h = l.blockHash ? l.blockHash.toLowerCase() : hashes.get(l.blockNumber) ?? (await chainHash(client, l.blockNumber));
        if (h) hashes.set(l.blockNumber, h);
      }
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
    if (hashes.size > 0) await r.saveHashes(opts.name, [...hashes].map(([block, hash]) => ({ block, hash })));
    await r.setCursor(opts.name, to + 1n);
    from = to + 1n;
  }
  if (track) await r.pruneBlocks(opts.name, from - window);
  await recheckRewound(r, opts, tip);
  await reportStuck(r, opts, now(), tune);
  return tip;
}

/** Whether any log came from a block whose hash differs from the one known for that block number. */
async function logsDisagree(client: Chain, r: Repo, source: string, logs: readonly Log[], known: ReadonlyMap<bigint, string>): Promise<boolean> {
  const seen = new Map(known);
  for (const l of logs) {
    if (l.blockNumber == null || !l.blockHash) continue;
    const h = l.blockHash.toLowerCase();
    // The hash already known for this block: from this range's read, the stored window, or (once per block) the chain now.
    const was = seen.get(l.blockNumber) ?? (await r.storedHash(source, l.blockNumber)) ?? (await chainHash(client, l.blockNumber));
    if (was && was.toLowerCase() !== h) return true;
    seen.set(l.blockNumber, h);
  }
  return false;
}

/** Runs the pending re-check once the indexer has caught up after a rewind. A failure leaves the list for the next pass. */
async function recheckRewound(r: Repo, opts: SyncOptions, tip: bigint) {
  const pending = await r.pendingRecheck(opts.name);
  if (pending.length === 0) return;
  if (opts.recheck) {
    try {
      await opts.recheck(pending, tip);
    } catch (e) {
      console.warn("reorg re-check", opts.name, cleanError(e));
      return;
    }
  }
  await r.clearRecheck(opts.name, pending);
}

/**
 * After a rewind, sets the records the dropped router logs were about to what the router holds at block `at`: each
 * position's armed state and keys, each owner's epoch, and each owed balance. A vanished arm switches off (and its waiting
 * exit jobs end), a vanished disarm switches the record back on for the usual settled check, a vanished claim restores the balance.
 */
export async function recheckRouter(
  client: Pick<PublicClient, "readContract">,
  r: Repo,
  router: Address,
  subjects: readonly string[],
  at: bigint,
): Promise<number> {
  let changed = 0;
  const read = (functionName: string, args: unknown[]) => client.readContract({ address: router, abi: routerAbi, functionName, args, blockNumber: at } as never) as Promise<unknown>;
  const owners = new Set<string>();
  const done = new Set<string>();
  for (const subject of subjects) {
    const s = subject.toLowerCase();
    if (/^0x0{24}[0-9a-f]{40}$/.test(s)) owners.add(`0x${s.slice(26)}`);
  }
  // Epochs first, so a position's own check sees the owner's current one.
  for (const owner of owners) await r.setEpoch(owner, BigInt((await read("epochOf", [owner])) as bigint));
  for (const subject of subjects) {
    for (const p of await r.positionsFor(subject.toLowerCase())) {
      if (done.has(p.pos_id)) continue;
      done.add(p.pos_id);
      const armed = (await read("isArmed", [p.pos_id])) as boolean;
      const keys = armed ? ((await read("keysOf", [p.pos_id])) as readonly string[]) : undefined;
      if (armed) await r.markSwaps(p.pos_id, ((await read("swapsOf", [p.pos_id]).catch(() => [])) as readonly unknown[]).length > 0);
      if (await r.syncArm(p.pos_id, armed, keys)) {
        changed++;
        if (!armed) await r.bump("arm_reorged");
        console.warn("reorg re-check changed a position", p.pos_id, armed ? "(armed again)" : "(not armed)");
      }
    }
  }
  for (const owner of owners) {
    for (const token of await r.owedTokens(owner)) await r.setOwed(owner, token, BigInt((await read("owed", [owner, token])) as bigint));
  }
  return changed;
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
async function retryParked(r: Repo, opts: SyncOptions, now: () => number, tune: RetryTuning, cursor: bigint) {
  const blocked = new Set<string>();
  for (const p of await r.parkedLogs(opts.name)) {
    // A log is only ever parked from a block behind the cursor. One at or ahead of it belongs to blocks a rewind dropped,
    // which the re-read brings back if they are still on chain.
    if (BigInt(p.block) >= cursor) continue;
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

/**
 * Arms are applied at the chain tip so exits stay fast: a position armed a second ago can be exited the moment its alarm
 * fires. Once an arm is `depth` blocks deep, this checks it against the router, read at that settled block. A position
 * the router does not hold as armed (the arm was reorged away, or a replayed log brought back one that was disarmed) is
 * switched off and its waiting exit jobs end. One the router holds is marked confirmed. A failed read leaves the record
 * as it is for the next pass. Returns how many records it switched off.
 */
export async function confirmArms(
  client: Pick<PublicClient, "getBlockNumber" | "readContract">,
  r: Repo,
  router: Address,
  depth: bigint,
): Promise<number> {
  const head = await client.getBlockNumber();
  if (head < depth) return 0;
  const settled = head - depth;
  let revoked = 0;
  for (const p of await r.unconfirmedArms(settled)) {
    try {
      const armed = await client.readContract({ address: router, abi: routerAbi, functionName: "isArmed", args: [p.pos_id as Hex], blockNumber: settled });
      if (armed) await r.confirmArm(p.pos_id, p.armed_block, p.terms_hash);
      else if (await r.revokeArm(p.pos_id, p.armed_block, p.terms_hash)) {
        revoked++;
        await r.bump("arm_reorged");
        console.warn("arm not on chain, record switched off", p.pos_id);
      }
    } catch (e) {
      console.warn("arm check", p.pos_id, cleanError(e));
    }
  }
  return revoked;
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
