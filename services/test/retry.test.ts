import { beforeEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { syncLogs, type Log } from "../src/indexer/indexer";
import { backoffSec, cleanError, RETRY_MAX_SEC, stuckLogText, type StuckLog } from "../src/indexer/retry";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const SIG = `0x${"99".repeat(32)}` as Hex;
const P1 = `0x${"01".repeat(32)}` as Hex;
const P2 = `0x${"02".repeat(32)}` as Hex;
const tx = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}` as Hex;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

const log = (i: number, subject: Hex | null = null, block = 100n + BigInt(i)): Log => ({
  address: A, data: "0x", topics: subject ? [SIG, subject] : [SIG], blockNumber: block, transactionHash: tx(i), logIndex: i,
});
const chain = (logs: Log[], tip = 1_000n) => ({ getBlockNumber: async () => tip, getLogs: async () => logs }) as never;
const clock = (start = 1_000) => {
  const t = { v: start };
  return { t, now: () => t.v };
};

describe("the indexer never drops a log", () => {
  test("a failing log is parked, the cursor moves on, and later logs land in the same pass", async () => {
    const seen: number[] = [];
    const { now } = clock();
    await syncLogs(chain([log(1, P1), log(2, P2), log(3)]), r, {
      name: "x", address: A, startBlock: 0n, now,
      onLog: async (l) => {
        if (l.logIndex === 1) throw new Error("rpc hiccup");
        seen.push(l.logIndex!);
      },
    });
    expect(seen).toEqual([2, 3]);
    expect(await r.cursor("x")).toBe(1_001n);
    const parked = await r.parkedLogs("x");
    expect(parked.map((p) => p.log_index)).toEqual([1]);
    expect(parked[0]!.last_error).toBe("rpc hiccup");
  });

  test("it is retried after a delay, with the original log, and removed once it applies", async () => {
    const { t, now } = clock();
    let fail = true;
    const got: Log[] = [];
    const opts = { name: "x", address: A, startBlock: 0n, now, onLog: async (l: Log) => {
      if (l.logIndex === 1 && fail) throw new Error("not yet");
      got.push(l);
    } };
    await syncLogs(chain([log(1, P1)]), r, opts);
    expect(got).toHaveLength(0);
    // Too soon: still waiting out the first delay, so the log is not tried.
    t.v += 2;
    fail = false;
    await syncLogs(chain([]), r, opts);
    expect(got).toHaveLength(0);
    t.v += 10;
    await syncLogs(chain([]), r, opts);
    expect(got).toHaveLength(1);
    expect(got[0]!.blockNumber).toBe(101n);
    expect(got[0]!.transactionHash).toBe(tx(1));
    expect(got[0]!.topics).toEqual([SIG, P1]);
    expect(await r.parkedLogs("x")).toEqual([]);
    expect((await r.health(t.v)).counters.log_recovered).toBe("1");
  });

  test("the wait doubles after each failure up to a cap, and the log is never given up on", async () => {
    expect([0, 1, 2, 3].map((n) => backoffSec(n))).toEqual([5, 10, 20, 40]);
    expect(backoffSec(50)).toBe(RETRY_MAX_SEC);
    const { t, now } = clock();
    const opts = { name: "x", address: A, startBlock: 0n, now, onLog: async () => { throw new Error("still broken"); } };
    await syncLogs(chain([log(1)]), r, opts);
    const waits: number[] = [];
    for (let i = 0; i < 40; i++) {
      t.v += RETRY_MAX_SEC;
      await syncLogs(chain([]), r, opts);
      const [p] = await r.parkedLogs("x");
      waits.push(p!.next_at - t.v);
    }
    expect(waits.slice(0, 4)).toEqual([10, 20, 40, 80]);
    expect(Math.max(...waits)).toBe(RETRY_MAX_SEC);
    const [p] = await r.parkedLogs("x");
    expect(p!.attempts).toBe(40);
  });

  test("a parked log survives a restart, because it lives in the database", async () => {
    const { t, now } = clock();
    await syncLogs(chain([log(1, P1)]), r, { name: "x", address: A, startBlock: 0n, now, onLog: async () => { throw new Error("down"); } });
    const afterRestart = repo(db);
    const got: number[] = [];
    t.v += 60;
    await syncLogs(chain([]), afterRestart, { name: "x", address: A, startBlock: 0n, now, onLog: async (l) => void got.push(l.logIndex!) });
    expect(got).toEqual([1]);
  });

  test("logs about the same thing stay in order: a later one waits behind a failed earlier one", async () => {
    const { t, now } = clock();
    const order: string[] = [];
    let armedFails = true;
    const opts = { name: "x", address: A, startBlock: 0n, now, onLog: async (l: Log) => {
      if (l.logIndex === 1 && armedFails) throw new Error("db blip");
      order.push(`${l.logIndex}`);
    } };
    // log 1 and log 2 are about the same position, and log 3 is about another.
    await syncLogs(chain([log(1, P1), log(2, P1), log(3, P2)]), r, opts);
    expect(order).toEqual(["3"]);
    expect((await r.parkedLogs("x")).map((p) => p.log_index)).toEqual([1, 2]);
    armedFails = false;
    t.v += 30;
    await syncLogs(chain([]), r, opts);
    expect(order).toEqual(["3", "1", "2"]);
    expect(await r.parkedLogs("x")).toEqual([]);
  });

  test("a new log about a parked thing joins the line, but logs about others are untouched", async () => {
    const { t, now } = clock();
    const order: number[] = [];
    let broken = true;
    const opts = { name: "x", address: A, startBlock: 0n, now, onLog: async (l: Log) => {
      if (l.logIndex === 1 && broken) throw new Error("blip");
      order.push(l.logIndex!);
    } };
    await syncLogs(chain([log(1, P1)]), r, opts);
    await syncLogs(chain([log(2, P1), log(3, P2)], 2_000n), r, opts);
    expect(order).toEqual([3]);
    broken = false;
    t.v += 30;
    await syncLogs(chain([]), r, opts);
    expect(order).toEqual([3, 1, 2]);
  });

  test("a log that keeps failing is reported once, after it has been failing for a while", async () => {
    const { t, now } = clock();
    const told: { source: string; sinceSec: number; attempts: number; error: string }[] = [];
    const opts = {
      name: "alarms", address: A, startBlock: 0n, now, retry: { stuckAfterSec: 120 },
      onLog: async () => { throw new Error("no alarm at 0xabc"); },
      onStuck: async (s: StuckLog) => void told.push(s),
    };
    await syncLogs(chain([log(1)]), r, opts);
    t.v += 100;
    await syncLogs(chain([]), r, opts);
    expect(told).toHaveLength(0);
    t.v += 30;
    await syncLogs(chain([]), r, opts);
    expect(told).toHaveLength(1);
    expect(told[0]!.source).toBe("alarms");
    expect(told[0]!.sinceSec).toBeGreaterThanOrEqual(120);
    expect(told[0]!.error).toBe("no alarm at 0xabc");
    t.v += 500;
    await syncLogs(chain([]), r, opts);
    expect(told).toHaveLength(1);
    expect((await r.health(t.v)).retryingLogs).toBe(1);
    expect((await r.health(t.v)).oldestRetryingLogSec).toBeGreaterThan(600);
  });

  test("if sending the report fails, the next pass tries again and the indexer keeps going", async () => {
    const { t, now } = clock();
    let calls = 0;
    const opts = {
      name: "x", address: A, startBlock: 0n, now, retry: { stuckAfterSec: 10 },
      onLog: async () => { throw new Error("bad"); },
      onStuck: async () => { if (++calls === 1) throw new Error("queue down"); },
    };
    await syncLogs(chain([log(1)]), r, opts);
    t.v += 20;
    await syncLogs(chain([]), r, opts);
    t.v += 20;
    await syncLogs(chain([]), r, opts);
    t.v += 20;
    await syncLogs(chain([]), r, opts);
    expect(calls).toBe(2);
  });

  test("the report names the chain's explorer link and hides RPC keys in the error", () => {
    const err = cleanError(new Error("HTTP request failed. URL: https://rpc.example.com/v2/SECRETKEY123 Details: timeout"));
    expect(err).not.toContain("SECRETKEY123");
    const text = stuckLogText(4663, { source: "alarms", tx: tx(1), logIndex: 1, block: 123n, attempts: 7, sinceSec: 600, error: err });
    expect(text).toContain("10 minutes");
    expect(text).toContain(`https://robinhoodchain.blockscout.com/tx/${tx(1)}`);
    expect(text).toContain("block 123");
    expect(text).not.toContain("SECRETKEY123");
  });
});
