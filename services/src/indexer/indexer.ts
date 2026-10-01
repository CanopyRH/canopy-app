import { decodeEventLog, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";
import { alarmBookAbi, erc20Abi, routerAbi } from "../chain/abi";
import { daysFor, extendPlan } from "../billing/prepaid";
import type { Db } from "../store/db";
import type { Repo } from "../store/repo";

const lc = (a: string) => a.toLowerCase();

export interface Log {
  address: Address;
  data: Hex;
  topics: [Hex, ...Hex[]] | [];
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
}

/** Applies one router log. Safe to replay: every write is an upsert. */
export async function applyRouterLog(r: Repo, log: Log) {
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

export function decodeFired(log: Log): FiredAlarm | null {
  const ev = decodeEventLog({ abi: alarmBookAbi, data: log.data, topics: log.topics as never, strict: false });
  if (ev.eventName !== "Fired") return null;
  const a = ev.args as { key: Hex; target: Address; evidence: Hex };
  return { key: a.key, target: a.target, evidence: a.evidence, tx: log.transactionHash };
}

const MAX_LOG_TRIES = 3;
const logTries = new Map<string, number>();

/**
 * Reads logs from the saved cursor in small ranges, so a restart resumes where it stopped.
 * A log that keeps failing is skipped and counted, because registering a detector is open to anyone and one bad log must not stop the indexer.
 */
export async function syncLogs(
  client: Pick<PublicClient, "getBlockNumber" | "getLogs">,
  r: Repo,
  opts: {
    name: string;
    address: Address | Address[];
    startBlock: bigint;
    step?: bigint;
    /** Narrows a busy contract, such as plan payments on the stablecoin. */
    filter?: { event: AbiEvent; args: Record<string, unknown> };
    onLog: (l: Log) => Promise<void>;
  },
) {
  const tip = await client.getBlockNumber();
  const step = opts.step ?? 2_000n;
  let from = (await r.cursor(opts.name)) ?? opts.startBlock;
  while (from <= tip) {
    const to = from + step - 1n > tip ? tip : from + step - 1n;
    const logs = await client.getLogs({ address: opts.address, fromBlock: from, toBlock: to, ...opts.filter } as never);
    for (const l of logs) {
      try {
        await opts.onLog(l as unknown as Log);
      } catch (e) {
        const id = `${l.transactionHash}:${l.logIndex}`;
        const n = (logTries.get(id) ?? 0) + 1;
        logTries.set(id, n);
        if (n < MAX_LOG_TRIES) throw e;
        console.error("skipped log", id, (e as Error).message);
        await r.bump("log_skipped");
      }
    }
    await r.setCursor(opts.name, to + 1n);
    from = to + 1n;
  }
  return tip;
}
