// While v1 is live, the indexer follows its admin events and new arms (the event shapes deployed at the git tag
// `v1-deployed`) on cursors of their own, and tells the ops chat. Runs on real Postgres when TEST_DATABASE_URL is set.
import { beforeEach, describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Abi, type Address, type Hex } from "viem";
import { alarmBookAbi, routerAbi } from "../src/chain/abi";
import { queueOps } from "../src/bot/queue";
import { loadEnv } from "../src/env";
import { adminEventOf } from "../src/indexer/admin";
import { syncLogs, type Log } from "../src/indexer/indexer";
import { applyV1AlarmLog, applyV1RouterLog, v1AlarmAdminEvent, v1AlarmBookAbi, v1AlarmsCursor, v1ArmOf, v1RouterAbi, v1RouterAdminEvent, v1RouterCursor } from "../src/indexer/v1";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { alarmsCursor, PARKED_CURSOR, routerCursor, switchContracts } from "../src/store/switch";
import { freshDb } from "./db";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const V1_ROUTER = "0x00000000000000000000000000000000000000e1" as Address;
const V1_BOOK = "0x00000000000000000000000000000000000000e2" as Address;
const TX = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}` as Hex;
const POS = TX(0x31);

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

function logOf(abi: Abi, eventName: string, args: Record<string, unknown>, tx = TX(1), logIndex = 0, block = 77n): Log {
  const item = (abi as readonly { type: string; name?: string; inputs: readonly { name: string; type: string; indexed?: boolean }[] }[]).find((x) => x.type === "event" && x.name === eventName)!;
  const topics = encodeEventTopics({ abi, eventName, args: Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]])) } as never);
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = plain.length ? encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never) : "0x";
  return { address: V1_ROUTER, data, topics: topics as never, blockNumber: block, transactionHash: tx, logIndex };
}
const v1r = (name: string, args: Record<string, unknown>, tx = TX(1), i = 0) => logOf(v1RouterAbi as unknown as Abi, name, args, tx, i);
const v1b = (name: string, args: Record<string, unknown>, tx = TX(1), i = 0) => logOf(v1AlarmBookAbi as unknown as Abi, name, args, tx, i);
const ARM = { posId: POS, owner: A, adapter: B, target: V1_BOOK, tokenId: 0n, harbour: 0, maxSlipBps: 0, termsHash: TX(9), keys: [TX(8)] };

const collect = () => {
  const got: { id: string; text: string }[] = [];
  return { got, ops: async (id: string, text: string) => void got.push({ id, text }) };
};

describe("v1 admin events", () => {
  const cases: [string, Record<string, unknown>, string[]][] = [
    ["AdapterSet", { adapter: A, allowed: true }, [`adapter=${A}`, "allowed=true"]],
    ["FeedSet", { token: A, feed: B, heartbeat: 3600, tokenDecimals: 18 }, [`token=${A}`, `feed=${B}`, "heartbeat=3600", "tokenDecimals=18"]],
    ["RouteSet", { token: A, path: "0x1234" }, [`token=${A}`, "path=0x1234"]],
    ["GuardianSet", { guardian: B }, [`guardian=${B}`]],
    ["ArmingPaused", { paused: true }, ["paused=true"]],
  ];
  for (const [name, args, parts] of cases) {
    test(`${name} on the v1 router reaches the ops chat with its arguments and an explorer link`, async () => {
      const { got, ops } = collect();
      await applyV1RouterLog(4663, v1r(name, args), ops);
      expect(got).toHaveLength(1);
      expect(got[0]!.text).toContain(`admin event ${name} on ExitRouter v1 in block 77`);
      for (const p of parts) expect(got[0]!.text.toLowerCase()).toContain(p.toLowerCase());
      expect(got[0]!.text).toContain(`https://robinhoodchain.blockscout.com/tx/${TX(1)}`);
      expect(got[0]!.id).toBe(`admin:${TX(1)}:0`);
    });
  }

  test("the v1 WatcherSet(address,bool) is reported from the v1 AlarmBook", async () => {
    const { got, ops } = collect();
    await applyV1AlarmLog(4663, v1b("WatcherSet", { watcher: B, allowed: false }), ops);
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toContain("admin event WatcherSet on AlarmBook v1");
    expect(got[0]!.text).toContain(`watcher=${B}`);
    expect(got[0]!.text).toContain("allowed=false");
  });

  test("the v2 WatcherSet(address,uint64,uint64) is not a v1 event", async () => {
    const v2 = logOf(alarmBookAbi as Abi, "WatcherSet", { watcher: B, since: 1n, until: 2n });
    expect(v1AlarmAdminEvent(v2)).toBeNull();
    expect(adminEventOf("AlarmBook", v2)).not.toBeNull();
  });

  test("other v1 events (exits, payouts, registrations) are ignored without an error", async () => {
    const { got, ops } = collect();
    // Paid and Disarmed have the same shape in v1 and v2; v1's ABI here names neither, and that must not throw.
    await applyV1RouterLog(4663, logOf(routerAbi as Abi, "Paid", { exitId: 1n, owner: A, token: B, amount: 5n, swapped: false }), ops);
    await applyV1RouterLog(4663, logOf(routerAbi as Abi, "Disarmed", { posId: POS, owner: A }), ops);
    await applyV1AlarmLog(4663, logOf(alarmBookAbi as Abi, "Fired", { key: TX(8), kind: 1, target: A, by: B, evidence: TX(7) }), ops);
    await applyV1AlarmLog(4663, logOf(alarmBookAbi as Abi, "Checkpoint", { key: TX(8), value: 5n }), ops);
    expect(got).toEqual([]);
    expect(v1RouterAdminEvent(logOf(routerAbi as Abi, "Paid", { exitId: 1n, owner: A, token: B, amount: 5n, swapped: false }))).toBeNull();
  });
});

describe("v1 arms", () => {
  test("a new arm on the v1 router is an ops alert naming the position, owner and vault, with the transaction", async () => {
    const { got, ops } = collect();
    await applyV1RouterLog(4663, v1r("Armed", ARM, TX(5), 3), ops);
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe(`v1arm:${TX(5)}:3`);
    expect(got[0]!.text).toContain("armed on the v1 ExitRouter in block 77");
    expect(got[0]!.text).toContain(POS);
    const text = got[0]!.text.toLowerCase();
    expect(text).toContain(`owner: ${A}`);
    expect(text).toContain(`vault: ${V1_BOOK}`);
    expect(got[0]!.text).toContain(`https://robinhoodchain.blockscout.com/tx/${TX(5)}`);
    expect(got[0]!.text).toContain("No keeper runs for v1");
    expect(v1ArmOf(v1r("Armed", ARM))?.posId).toBe(POS);
  });

  test("the v2 router's reader never sees v1 arms as positions: nothing is written", async () => {
    const { ops } = collect();
    await applyV1RouterLog(4663, v1r("Armed", ARM), ops);
    for (const t of ["positions", "exits", "alarms", "detectors"]) expect(await db.query(`SELECT 1 FROM ${t}`)).toHaveLength(0);
  });
});

describe("on cursors of their own", () => {
  const client = (logs: Log[]) => ({
    getBlockNumber: async () => 100n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => logs.filter((l) => l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock),
  });
  const reader = (logs: Log[], got: { id: string; text: string }[]) =>
    syncLogs(client(logs) as never, r, {
      name: v1RouterCursor(V1_ROUTER), address: V1_ROUTER, startBlock: 50n,
      onLog: (l) => applyV1RouterLog(4663, l, async (id, text) => { got.push({ id, text }); await queueOps(r, id, text, 1_000); }),
    });

  test("the reader reads once, queues each message once and keeps its cursor", async () => {
    const logs = [v1r("ArmingPaused", { paused: true }, TX(1), 0), v1r("Armed", ARM, TX(2), 0)];
    const got: { id: string; text: string }[] = [];
    await reader(logs, got);
    expect(got).toHaveLength(2);
    expect(await r.cursor(v1RouterCursor(V1_ROUTER))).toBe(101n);
    await reader(logs, got); // another pass: nothing new to read
    expect(got).toHaveLength(2);
    expect(await r.dueJobs("ops", 1_000)).toHaveLength(2);
    // The same logs again (a rewound reader) queue the same two rows.
    await r.setCursor(v1RouterCursor(V1_ROUTER), 50n);
    await reader(logs, got);
    expect(await r.dueJobs("ops", 1_000)).toHaveLength(2);
  });

  test("the names are not the plain router/alarms names, so the switch neither parks nor deletes them", async () => {
    const V1 = { router: "0x00000000000000000000000000000000000000a1", alarmBook: "0x00000000000000000000000000000000000000a2", startBlock: 100n };
    const V2 = { router: "0x00000000000000000000000000000000000000b1", alarmBook: "0x00000000000000000000000000000000000000b2", startBlock: 5_000n };
    await db.query(`INSERT INTO meta (key, value) VALUES ('router',$1), ('alarm_book',$2)`, [V1.router, V1.alarmBook]);
    await r.setCursor("router", 900n);
    await r.setCursor("alarms", 901n);
    await r.setCursor(routerCursor(V1.router), 902n);
    await r.setCursor(v1RouterCursor(V1_ROUTER), 903n);
    await r.setCursor(v1AlarmsCursor(V1_BOOK), 904n);
    await db.query(`INSERT INTO block_hashes (source, block, hash) VALUES ($1, 1, 'h')`, [v1RouterCursor(V1_ROUTER)]);
    await switchContracts(db, V2, V2.router);
    expect(await r.cursor("router")).toBe(PARKED_CURSOR);
    expect(await r.cursor("alarms")).toBe(PARKED_CURSOR);
    expect(await r.cursor(routerCursor(V1.router))).toBeNull();
    expect(await r.cursor(routerCursor(V2.router))).toBe(4_999n);
    expect(await r.cursor(alarmsCursor(V2.alarmBook))).toBe(4_999n);
    expect(await r.cursor(v1RouterCursor(V1_ROUTER))).toBe(903n);
    expect(await r.cursor(v1AlarmsCursor(V1_BOOK))).toBe(904n);
    expect(await db.query(`SELECT 1 FROM block_hashes WHERE source=$1`, [v1RouterCursor(V1_ROUTER)])).toHaveLength(1);
  });
});

describe("V1_ROUTER and V1_ALARM_BOOK", () => {
  const base = {
    PUBLIC_URL: "https://api.example.test", DATABASE_URL: "x", CHAIN_ID: "4663", RPC_URL: "http://rpc.test/a", RPC_URL_BACKUP: "http://rpc.test/b",
    ROUTER: A, ALARM_BOOK: B, ADAPTER_4626: A, PLAN_PAY_ADDRESS: A, PLAN_TOKEN: A, TELEGRAM_BOT_TOKEN: "1:t", TELEGRAM_WEBHOOK_SECRET: "s".repeat(20),
  };
  test("both are optional, and off by default", () => {
    const e = loadEnv(base);
    expect(e.V1_ROUTER).toBeUndefined();
    expect(e.V1_ALARM_BOOK).toBeUndefined();
    expect(e.V1_START_BLOCK).toBeUndefined();
  });
  test("set, they are addresses", () => {
    expect(loadEnv({ ...base, V1_ROUTER, V1_ALARM_BOOK: V1_BOOK, V1_START_BLOCK: "123" })).toMatchObject({ V1_ROUTER, V1_ALARM_BOOK: V1_BOOK, V1_START_BLOCK: 123n });
    expect(() => loadEnv({ ...base, V1_ROUTER: "0x12" })).toThrow();
  });
  test("they must not be the contracts the service runs on", () => {
    expect(() => loadEnv({ ...base, V1_ROUTER: A })).toThrow();
    expect(() => loadEnv({ ...base, V1_ALARM_BOOK: B.toUpperCase().replace("0X", "0x") })).toThrow();
  });
});
