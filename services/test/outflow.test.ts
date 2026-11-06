// The large-outflow alert: one exit paying out more than OUTFLOW_ALERT of the stablecoin, or one vault's exits adding up to
// more within an hour, queues an ops message. Runs on real Postgres when TEST_DATABASE_URL is set.
import { beforeEach, describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Abi, type Address, type Hex } from "viem";
import { routerAbi } from "../src/chain/abi";
import { loadEnv } from "../src/env";
import { applyRouterLog, type Log } from "../src/indexer/indexer";
import { money, outflowThreshold, type OutflowWatch } from "../src/indexer/outflow";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const STABLE = "0x00000000000000000000000000000000000000c1" as Address;
const OTHER = "0x00000000000000000000000000000000000000c2" as Address;
const VAULT_A = "0x00000000000000000000000000000000000000a1" as Address;
const VAULT_B = "0x00000000000000000000000000000000000000a2" as Address;
const OWNER = "0x00000000000000000000000000000000000000b1" as Address;
const TX = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}` as Hex;
const POS_A = TX(0x61), POS_B = TX(0x62);
const USD = 1_000_000n;
const LIMIT = 50_000n * USD;

let db: Db;
let r: Repo;
let alerts: { id: string; text: string }[];
/** Block n happened at this many seconds. */
let times: Map<bigint, number>;
let watch: OutflowWatch;

beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
  alerts = [];
  times = new Map();
  watch = {
    chainId: 4663, stable: STABLE.toLowerCase(), threshold: LIMIT,
    blockTime: async (b) => times.get(b) ?? 0,
    alert: async (id, text) => void alerts.push({ id, text }),
  };
  for (const [posId, target] of [[POS_A, VAULT_A], [POS_B, VAULT_B]] as const) {
    await r.upsertPosition({ posId, owner: OWNER, adapter: OTHER, target, tokenId: 0n, harbour: 1, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [] });
  }
});

function log(eventName: string, args: Record<string, unknown>, tx: Hex, logIndex: number, block: bigint): Log {
  const abi = routerAbi as Abi;
  const item = (abi as readonly { type: string; name?: string; inputs: readonly { name: string; type: string; indexed?: boolean }[] }[]).find((x) => x.type === "event" && x.name === eventName)!;
  const topics = encodeEventTopics({ abi, eventName, args: Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]])) } as never);
  const plain = item.inputs.filter((i) => !i.indexed);
  const data = plain.length ? encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never) : "0x";
  return { address: OTHER, data, topics: topics as never, blockNumber: block, transactionHash: tx, logIndex, blockHash: null };
}
const paid = (exitId: bigint, amount: bigint, tx: Hex, i = 0, block = 10n, token: Address = STABLE) =>
  applyRouterLog(r, log("Paid", { exitId, owner: OWNER, token, amount, swapped: false }, tx, i, block), undefined, watch);
const exited = (exitId: bigint, posId: Hex, tx: Hex, block: bigint) =>
  applyRouterLog(r, log("Exited", { exitId, posId, owner: OWNER, caller: OWNER, alarmKey: TX(0), viaAlarm: false }, tx, 9, block), undefined, watch);
/** A whole exit: its payout, then its Exited log, as the router emits them. */
async function exit(exitId: bigint, posId: Hex, amount: bigint, tx: Hex, block: bigint, at: number) {
  times.set(block, at);
  await paid(exitId, amount, tx, 0, block);
  await exited(exitId, posId, tx, block);
}

describe("one exit", () => {
  test("exactly the limit is quiet; one unit more queues an alert with the amount and the transaction", async () => {
    await paid(1n, LIMIT, TX(1));
    expect(alerts).toEqual([]);
    await paid(1n, 1n, TX(1), 1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain("one exit paid out 50,000.00");
    expect(alerts[0]!.text).toContain("over the 50,000.00 limit (exit 1)");
    expect(alerts[0]!.text).toContain(`https://robinhoodchain.blockscout.com/tx/${TX(1)}`);
    expect(alerts[0]!.text).toContain("INCIDENT.md");
  });

  test("payouts add up across the exit's logs, and one exit alerts once per transaction id", async () => {
    await paid(2n, 30_000n * USD, TX(2), 0);
    await paid(2n, 30_000n * USD, TX(2), 1); // crosses here
    await paid(2n, 1n * USD, TX(2), 2); // still over, same id
    expect(alerts.map((a) => a.id)).toEqual([`outflow:exit:2:${TX(2)}`, `outflow:exit:2:${TX(2)}`]);
    expect(alerts[0]!.text).toContain("60,000.00");
  });

  test("a replayed log gives the same alert id, which the ops queue keeps once", async () => {
    const { queueOps } = await import("../src/bot/queue");
    watch.alert = async (id, text) => queueOps(r, id, text, 1_000);
    for (let i = 0; i < 3; i++) await paid(3n, 90_000n * USD, TX(3));
    expect(await r.dueJobs("ops", 1_000)).toHaveLength(1);
  });

  test("a big payout in another token is not counted, because it has no price here", async () => {
    await paid(4n, 10_000_000n * USD, TX(4), 0, 10n, OTHER);
    expect(alerts).toEqual([]);
  });

  test("two small exits are two exits, not one", async () => {
    await paid(5n, 40_000n * USD, TX(5));
    await paid(6n, 40_000n * USD, TX(6));
    expect(alerts).toEqual([]);
  });

  test("a threshold of 0 turns every check off", async () => {
    watch.threshold = 0n;
    await exit(7n, POS_A, 900_000n * USD, TX(7), 20n, 1_000);
    expect(alerts).toEqual([]);
  });

  test("without a watch, logs are recorded and nothing else happens", async () => {
    await applyRouterLog(r, log("Paid", { exitId: 8n, owner: OWNER, token: STABLE, amount: 900_000n * USD, swapped: false }, TX(8), 0, 10n));
    await applyRouterLog(r, log("Exited", { exitId: 8n, posId: POS_A, owner: OWNER, caller: OWNER, alarmKey: TX(0), viaAlarm: false }, TX(8), 9, 10n));
    expect(alerts).toEqual([]);
    expect(await r.stablePaidForExit(8n, STABLE)).toBe(900_000n * USD);
  });
});

describe("one vault within an hour", () => {
  test("three exits of 20,000 within the hour alert on the third, naming the vault", async () => {
    await exit(10n, POS_A, 20_000n * USD, TX(10), 100n, 10_000);
    await exit(11n, POS_A, 20_000n * USD, TX(11), 200n, 10_600);
    expect(alerts).toEqual([]);
    await exit(12n, POS_A, 20_000n * USD, TX(12), 300n, 11_200);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.id).toBe(`outflow:vault:${VAULT_A}:${Math.floor(11_200 / 3600)}`);
    expect(alerts[0]!.text).toContain(`exits from vault ${VAULT_A} paid out 60,000.00 of the stablecoin within an hour`);
    expect(alerts[0]!.text).toContain(`https://robinhoodchain.blockscout.com/tx/${TX(12)}`);
  });

  test("exits more than an hour apart do not add up", async () => {
    await exit(20n, POS_A, 30_000n * USD, TX(20), 100n, 10_000);
    await exit(21n, POS_A, 30_000n * USD, TX(21), 200n, 10_000 + 3_601);
    expect(alerts).toEqual([]);
    await exit(22n, POS_A, 30_000n * USD, TX(22), 300n, 10_000 + 3_601 + 60);
    expect(alerts).toHaveLength(1); // the last two are 60,000 inside one hour
  });

  test("two vaults are counted apart", async () => {
    await exit(30n, POS_A, 30_000n * USD, TX(30), 100n, 10_000);
    await exit(31n, POS_B, 30_000n * USD, TX(31), 200n, 10_100);
    expect(alerts).toEqual([]);
  });

  test("a drain that keeps going alerts once per vault per clock hour", async () => {
    await exit(40n, POS_A, 60_000n * USD, TX(40), 100n, 7_300);
    await exit(41n, POS_A, 60_000n * USD, TX(41), 200n, 7_400);
    await exit(42n, POS_A, 60_000n * USD, TX(42), 300n, 7_500);
    // The first two exits are also over the per-exit limit; count only the vault alerts.
    const vault = alerts.filter((a) => a.id.startsWith("outflow:vault:"));
    expect(new Set(vault.map((a) => a.id)).size).toBe(1);
    expect(alerts.filter((a) => a.id.startsWith("outflow:exit:"))).toHaveLength(3);
  });

  test("exits that other tokens paid, and exits with no recorded time, are not counted", async () => {
    times.set(100n, 10_000);
    await paid(50n, 90_000n * USD, TX(50), 0, 100n, OTHER);
    await exited(50n, POS_A, TX(50), 100n);
    await applyRouterLog(r, log("Paid", { exitId: 51n, owner: OWNER, token: STABLE, amount: 40_000n * USD, swapped: false }, TX(51), 0, 101n));
    await applyRouterLog(r, log("Exited", { exitId: 51n, posId: POS_A, owner: OWNER, caller: OWNER, alarmKey: TX(0), viaAlarm: false }, TX(51), 9, 101n)); // no watch, so no time
    await exit(52n, POS_A, 40_000n * USD, TX(52), 102n, 10_100);
    expect(alerts).toEqual([]);
  });
});

describe("OUTFLOW_ALERT", () => {
  const base = {
    PUBLIC_URL: "https://api.example.test", DATABASE_URL: "x", CHAIN_ID: "4663", RPC_URL: "http://rpc.test/a", RPC_URL_BACKUP: "http://rpc.test/b",
    ROUTER: VAULT_A, ALARM_BOOK: VAULT_B, ADAPTER_4626: OTHER, PLAN_PAY_ADDRESS: OTHER, PLAN_TOKEN: STABLE, TELEGRAM_BOT_TOKEN: "1:t", TELEGRAM_WEBHOOK_SECRET: "s".repeat(20),
  };
  test("defaults to 50,000 stablecoin units and converts to 6 decimals", () => {
    const e = loadEnv(base);
    expect(e.OUTFLOW_ALERT).toBe(50_000);
    expect(outflowThreshold(e.OUTFLOW_ALERT)).toBe(50_000_000_000n);
  });
  test("is configurable, can be fractional, and 0 turns it off", () => {
    expect(outflowThreshold(loadEnv({ ...base, OUTFLOW_ALERT: "12500.5" }).OUTFLOW_ALERT)).toBe(12_500_500_000n);
    expect(loadEnv({ ...base, OUTFLOW_ALERT: "0" }).OUTFLOW_ALERT).toBe(0);
    expect(() => loadEnv({ ...base, OUTFLOW_ALERT: "-1" })).toThrow();
  });
  test("amounts read as money", () => {
    expect(money(0n)).toBe("0.00");
    expect(money(1_234_567_890n)).toBe("1,234.57");
    expect(money(50_000n * USD)).toBe("50,000.00");
  });
});
