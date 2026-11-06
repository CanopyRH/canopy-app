// The switch is the operator's decision: a service on other addresses refuses to start unless CONTRACT_SWITCH names its
// router, a switched database never goes back, and every writer checks the stored addresses before it acts.
// Runs on real Postgres when TEST_DATABASE_URL is set.
import { beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { alarmsCursor, contractFence, ContractMismatch, routerCursor, SwitchRefused, switchContracts } from "../src/store/switch";
import { freshDb } from "./db";

const V1 = { router: "0x00000000000000000000000000000000000000a1", alarmBook: "0x00000000000000000000000000000000000000a2", startBlock: 100n };
const V2 = { router: "0x00000000000000000000000000000000000000b1", alarmBook: "0x00000000000000000000000000000000000000b2", startBlock: 5_000n };
const OWNER = "0x00000000000000000000000000000000000000c1";
const KEY = `0x${"11".repeat(32)}`;
const POS = `0x${"22".repeat(32)}`;

let db: Db;
let r: Repo;
const n = async (table: string, where = "true") => Number((await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${table} WHERE ${where}`))[0]!.c);
const stored = async () => (await db.query<{ key: string; value: string }>(`SELECT key, value FROM meta ORDER BY key`)).map((x) => `${x.key}=${x.value}`);

const position = (router: string, block: bigint) =>
  r.upsertPosition({ posId: POS, owner: OWNER, adapter: router, target: V2.alarmBook, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block, termsHash: "t", keys: [KEY] });

/** A database that holds v1 state, with the v1 addresses stored. */
async function onV1() {
  await position(V1.router, 120n);
  await r.setCursor(routerCursor(V1.router), 900n);
  await db.query(`INSERT INTO meta (key, value) VALUES ('router',$1), ('alarm_book',$2)`, [V1.router, V1.alarmBook]);
}

beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

describe("the switch is the operator's decision", () => {
  test("new addresses with no CONTRACT_SWITCH refuse, and nothing is cleared or stored", async () => {
    await onV1();
    await expect(switchContracts(db, V2)).rejects.toBeInstanceOf(SwitchRefused);
    expect(await n("positions")).toBe(1);
    expect(await stored()).toEqual([`alarm_book=${V1.alarmBook}`, `router=${V1.router}`]);
    expect(await r.cursor(routerCursor(V1.router))).toBe(900n);
  });

  test("a CONTRACT_SWITCH that is not this service's router refuses too", async () => {
    await onV1();
    await expect(switchContracts(db, V2, V1.router)).rejects.toBeInstanceOf(SwitchRefused);
    expect(await n("positions")).toBe(1);
  });

  test("rows with no stored addresses need the same authorisation", async () => {
    await position(V1.router, 120n);
    await expect(switchContracts(db, V2)).rejects.toBeInstanceOf(SwitchRefused);
    expect(await n("positions")).toBe(1);
    expect(await switchContracts(db, V2, V2.router)).not.toBeNull();
    expect(await n("positions")).toBe(0);
  });

  test("once switched, a start on the old addresses refuses, even with the variable still set", async () => {
    await onV1();
    expect(await switchContracts(db, V2, V2.router)).not.toBeNull();
    await position(V2.router, 5_100n);
    await r.enqueue("exit", `${KEY}:1000:${POS}`, { posId: POS }, 1_000);
    await expect(switchContracts(db, V1)).rejects.toBeInstanceOf(SwitchRefused);
    await expect(switchContracts(db, V1, V2.router)).rejects.toBeInstanceOf(SwitchRefused);
    // v2 state, its cursors and its exit job are still there.
    expect(await n("positions")).toBe(1);
    expect(await n("jobs", "kind='exit' AND NOT done")).toBe(1);
    expect(await r.cursor(routerCursor(V2.router))).toBe(4_999n);
    expect(await r.cursor(alarmsCursor(V2.alarmBook))).toBe(4_999n);
    expect(await stored()).toEqual([`alarm_book=${V2.alarmBook}`, `router=${V2.router}`]);
    // The v2 deploy itself keeps starting, with or without the variable.
    expect(await switchContracts(db, V2, V2.router)).toBeNull();
    expect(await switchContracts(db, V2)).toBeNull();
  });

  test("a new database stores its addresses whether or not the variable is set", async () => {
    expect(await switchContracts(db, V2, V2.router)).toBeNull();
    expect(await stored()).toEqual([`alarm_book=${V2.alarmBook}`, `router=${V2.router}`]);
  });

  test("a reader on other addresses has cursors of its own and can't move the new ones", async () => {
    await onV1();
    await switchContracts(db, V2, V2.router);
    await r.setCursor(routerCursor(V1.router), 99_999n); // what an old indexer does
    expect(await r.cursor(routerCursor(V2.router))).toBe(4_999n);
    expect(routerCursor(V2.router.toUpperCase().replace("0X", "0x"))).toBe(routerCursor(V2.router));
  });

  test("the fence passes for the stored addresses and throws for any others", async () => {
    await onV1();
    await switchContracts(db, V2, V2.router);
    await contractFence(db, V2)();
    await expect(contractFence(db, V1)()).rejects.toBeInstanceOf(ContractMismatch);
    await expect(contractFence(db, { router: V2.router, alarmBook: V1.alarmBook })()).rejects.toBeInstanceOf(ContractMismatch);
    await db.query(`DELETE FROM meta`);
    await expect(contractFence(db, V2)()).rejects.toBeInstanceOf(ContractMismatch);
  });
});
