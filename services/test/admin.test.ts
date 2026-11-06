import { beforeEach, describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Abi, type Address, type Hex } from "viem";
import { alarmBookAbi, routerAbi } from "../src/chain/abi";
import { queueOps, sendQueuedOps, OPS_TRIES } from "../src/bot/queue";
import { adminAlertId, adminAlertText, adminEventOf, type AdminEvent } from "../src/indexer/admin";
import { applyAlarmAdmin, applyRouterLog, syncLogs, type Log } from "../src/indexer/indexer";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const TX = `0x${"44".repeat(32)}` as Hex;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

/** Builds a log the way the chain would emit it, from the event's own ABI entry. */
function logOf(abi: Abi, eventName: string, args: Record<string, unknown>, logIndex = 0): Log {
  const item = (abi as readonly { type: string; name?: string; inputs: readonly { name: string; type: string; indexed?: boolean }[] }[]).find((x) => x.type === "event" && x.name === eventName)!;
  const topics = encodeEventTopics({ abi, eventName, args: Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]])) } as never);
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = plain.length ? encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never) : "0x";
  return { address: A, data, topics: topics as never, blockNumber: 77n, transactionHash: TX, logIndex };
}

const router = (name: string, args: Record<string, unknown>, i = 0) => logOf(routerAbi as Abi, name, args, i);
const alarms = (name: string, args: Record<string, unknown>, i = 0) => logOf(alarmBookAbi as Abi, name, args, i);

const ADMIN_LOGS: [string, () => Log, string[]][] = [
  ["AdapterSet", () => router("AdapterSet", { adapter: A, allowed: true }), [`adapter=${A}`, "allowed=true"]],
  ["FeedSet", () => router("FeedSet", { token: A, feed: B, heartbeat: 3600, tokenDecimals: 6 }), [`token=${A}`, `feed=${B}`, "heartbeat=3600", "tokenDecimals=6"]],
  ["RouteSet", () => router("RouteSet", { token: A, path: "0x1234" }), [`token=${A}`, "path=0x1234"]],
  ["GuardianSet", () => router("GuardianSet", { guardian: B }), [`guardian=${B}`]],
  ["ArmingPaused", () => router("ArmingPaused", { paused: true }), ["paused=true"]],
];

describe("admin event alerts", () => {
  for (const [name, make, parts] of ADMIN_LOGS) {
    test(`${name} reaches the operator queue with its arguments and an explorer link`, async () => {
      const seen: AdminEvent[] = [];
      await applyRouterLog(r, make(), async (e) => void seen.push(e));
      expect(seen).toHaveLength(1);
      const text = adminAlertText(4663, seen[0]!);
      expect(text).toContain(`admin event ${name} on ExitRouter in block 77`);
      for (const p of parts) expect(text.toLowerCase()).toContain(p.toLowerCase());
      expect(text).toContain(`https://robinhoodchain.blockscout.com/tx/${TX}`);
      expect(text).toContain("INCIDENT.md");
    });
  }

  test("a watcher being allowed or removed is reported from the AlarmBook", async () => {
    const seen: AdminEvent[] = [];
    for (const allowed of [true, false]) expect(await applyAlarmAdmin(alarms("WatcherSet", { watcher: B, allowed }), async (e) => void seen.push(e))).toBe(true);
    expect(seen.map((e) => e.args)).toEqual([[["watcher", B], ["allowed", "true"]], [["watcher", B], ["allowed", "false"]]]);
    expect(seen[0]!.contract).toBe("AlarmBook");
  });

  test("ordinary events are not admin events, on either contract", async () => {
    const seen: AdminEvent[] = [];
    const onAdmin = async (e: AdminEvent) => void seen.push(e);
    await applyRouterLog(r, router("Disarmed", { posId: TX, owner: A }), onAdmin);
    await applyRouterLog(r, router("SwapSkipped", { token: A, amount: 1n }), onAdmin);
    expect(await applyAlarmAdmin(alarms("Checkpoint", { key: TX, value: 5n }), onAdmin)).toBe(false);
    expect(await applyAlarmAdmin(alarms("Fired", { key: TX, kind: 1, target: A, by: B, evidence: TX }), onAdmin)).toBe(false);
    expect(seen).toEqual([]);
    expect(adminEventOf("ExitRouter", router("Disarmed", { posId: TX, owner: A }))).toBeNull();
  });

  test("without a handler, an admin event on the router is simply ignored", async () => {
    await applyRouterLog(r, router("ArmingPaused", { paused: true }));
  });

  test("a long route path is shortened, and an unknown chain still gets the transaction hash", () => {
    const e = adminEventOf("ExitRouter", router("RouteSet", { token: A, path: `0x${"ab".repeat(200)}` }))!;
    expect(e.args[1]![1].length).toBeLessThan(140);
    const text = adminAlertText(1, e);
    expect(text).toContain(`Transaction: ${TX}`);
  });

  test("a replayed log queues one operator message", async () => {
    const e = adminEventOf("ExitRouter", router("ArmingPaused", { paused: true }))!;
    for (let i = 0; i < 3; i++) await queueOps(r, adminAlertId(e), adminAlertText(4663, e), 100);
    const sent: string[] = [];
    await sendQueuedOps(r, async (t) => void sent.push(t), () => 100);
    await sendQueuedOps(r, async (t) => void sent.push(t), () => 100);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("ArmingPaused");
  });

  test("the indexer only queues, so a Telegram that never answers does not hold up the next logs", async () => {
    const onAdmin = (e: AdminEvent) => queueOps(r, adminAlertId(e), adminAlertText(4663, e), 100);
    const logs = [router("ArmingPaused", { paused: true }, 0), router("Disarmed", { posId: TX, owner: A }, 1), router("GuardianSet", { guardian: B }, 2)];
    const client = { getBlockNumber: async () => 10n, getLogs: async () => logs } as never;
    const applied: string[] = [];
    await syncLogs(client, r, { name: "router", address: A, startBlock: 0n, onLog: async (l) => {
      applied.push(`${l.logIndex}`);
      await applyRouterLog(r, l, onAdmin);
    } });
    expect(applied).toEqual(["0", "1", "2"]);
    expect(await r.cursor("router")).toBe(11n);
    // Nothing was sent yet: the messages wait in the queue for the send loop, which runs apart from the indexer.
    expect((await r.dueJobs("ops", 100)).length).toBe(2);
  });

  test("a failed send is retried and finally dropped after the allowed tries", async () => {
    await queueOps(r, "x", "hello", 0);
    let calls = 0;
    const fail = async () => {
      calls++;
      throw new Error("telegram down");
    };
    let t = 0;
    for (let i = 0; i < OPS_TRIES + 3; i++) {
      await sendQueuedOps(r, fail, () => t);
      t += 31;
    }
    expect(calls).toBe(OPS_TRIES);
    expect(await r.dueJobs("ops", t + 1000)).toEqual([]);
  });

  test("a message that fails once is sent on the next pass", async () => {
    await queueOps(r, "y", "hello", 0);
    let first = true;
    const flaky = async (text: string) => {
      if (first) {
        first = false;
        throw new Error("blip");
      }
      expect(text).toBe("hello");
    };
    await sendQueuedOps(r, flaky, () => 0);
    expect(await r.dueJobs("ops", 0)).toEqual([]); // waiting out the retry delay
    await sendQueuedOps(r, flaky, () => 60);
    expect(await r.dueJobs("ops", 1000)).toEqual([]);
  });
});
