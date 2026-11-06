// The contract switch: v1 state is cleared once when the addresses change, and what belongs to people and chats is not.
// Runs on real Postgres when TEST_DATABASE_URL is set.
import { beforeEach, describe, expect, test } from "bun:test";
import { postgres, type Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { alarmsCursor, contractFence, ContractMismatch, routerCursor, SwitchRefused, switchContracts, switchText, PARKED_CURSOR } from "../src/store/switch";
import { freshDb } from "./db";

const V1 = { router: "0x00000000000000000000000000000000000000a1", alarmBook: "0x00000000000000000000000000000000000000a2", startBlock: 100n };
const V2 = { router: "0x00000000000000000000000000000000000000b1", alarmBook: "0x00000000000000000000000000000000000000b2", startBlock: 5_000n };
const GO = { router: V2.router }; // CONTRACT_SWITCH = the new router: the operator authorises the move
const OWNER = "0x00000000000000000000000000000000000000c1";
const KEY = `0x${"11".repeat(32)}`;
const POS = `0x${"22".repeat(32)}`;
const TX = `0x${"33".repeat(32)}`;
const HASH = `0x${"44".repeat(32)}`;

let db: Db;
let r: Repo;
const n = async (table: string, where = "true") => Number((await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${table} WHERE ${where}`))[0]!.c);

/** v1 state in every table the switch clears, and people's state in every table it must keep. */
async function seed() {
  await r.upsertPosition({ posId: POS, owner: OWNER, adapter: V1.router, target: V1.alarmBook, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 120n, termsHash: "t", keys: [KEY] });
  await r.setEpoch(OWNER, 3n);
  await db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b, block) VALUES ($1,5,$2,2,0,$3,$3,120)`, [KEY, OWNER, HASH]);
  await db.query(`INSERT INTO alarms (key, fired_at, tx, evidence, block) VALUES ($1,1000,$2,$3,130)`, [KEY, TX, HASH]);
  await db.query(`INSERT INTO exits (exit_id, pos_id, owner, caller, alarm_key, via_alarm, tx, block) VALUES (1,$1,$2,$2,$3,true,$4,131)`, [POS, OWNER, KEY, TX]);
  await db.query(`INSERT INTO exit_payouts (exit_id, tx, log_index, token, amount, swapped, block) VALUES (1,$1,0,$2,5,false,131)`, [TX, OWNER]);
  await db.query(`INSERT INTO owed (owner, token, amount) VALUES ($1,$1,7)`, [OWNER]);
  await db.query(`INSERT INTO owed_logs (tx, log_index, owner, token, amount, block) VALUES ($1,0,$2,$2,7,131)`, [TX, OWNER]);
  await db.query(`INSERT INTO attestations (key, evidence_hash, deadline, signer, sig) VALUES ($1,$2,9,$3,'0x01')`, [KEY, HASH, OWNER]);
  await r.enqueue("exit", `${KEY}:1000:${POS}`, { posId: POS }, 1);
  await r.parkLog({ source: routerCursor(V1.router), tx: TX, logIndex: 0, subject: POS, block: 125n, log: { x: 1 }, now: 1, nextAt: 2, error: "e" });
  for (const source of [routerCursor(V1.router), alarmsCursor(V1.alarmBook), "router", "alarms", "payments"]) {
    await db.query(`INSERT INTO block_hashes (source, block, hash) VALUES ($1,140,$2)`, [source, HASH]);
    await db.query(`INSERT INTO log_touches (source, block, subject) VALUES ($1,140,$2)`, [source, POS]);
    await db.query(`INSERT INTO reorg_recheck (source, subject) VALUES ($1,$2)`, [source, POS]);
    await r.setCursor(source, 900n);
  }
  // People and chats.
  await r.setPaidUntil(OWNER, 4_000_000_000);
  await r.recordPayment({ tx: TX, logIndex: 1, wallet: OWNER, amount: 15_000_000n, credited: true, at: 5, block: 135n });
  await r.follow(55, V1.alarmBook);
  await db.query(`INSERT INTO feed_items (sha256, source_url, raw, label, protocol, confidence, at) VALUES ('abc','u','raw','IRRELEVANT','p',0.5,1)`);
  await db.query(`INSERT INTO signals (kind, target, severity, value, evidence, at) VALUES ('DRAIN',$1,'soft',1,'e',1)`, [OWNER]);
  await db.query(`INSERT INTO risk_cards (target, numbers, text, updated_at) VALUES ($1,'{}','card',1)`, [OWNER]);
  await db.query(`INSERT INTO vault_snaps (target, t, total_assets, share_price) VALUES ($1,1,1,1)`, [OWNER]);
  await db.query(`INSERT INTO sent_alerts (target, kind, at) VALUES ($1,'fired:x',1)`, [OWNER]);
  await r.enqueue("alert", "a1", { vault: OWNER, text: "hi" }, 1);
  await r.enqueue("ops", "ops:o1", { text: "hi" }, 1);
}

const contractTables = ["positions", "position_keys", "owner_epochs", "detectors", "alarms", "exits", "exit_payouts", "owed", "owed_logs", "attestations", "log_retries"];

beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

describe("the contract switch", () => {
  test("a database that already holds v1 state is cleared once, and people's state is untouched", async () => {
    await seed();
    await db.query(`INSERT INTO meta (key, value) VALUES ('router',$1), ('alarm_book',$2)`, [V1.router, V1.alarmBook]);
    const before = { plans: await n("plans"), pay: await n("plan_payments"), follows: await n("vault_follows"), feed: await n("feed_items"), signals: await n("signals"), cards: await n("risk_cards"), snaps: await n("vault_snaps"), sent: await n("sent_alerts") };
    const res = await switchContracts(db, V2, GO.router);
    expect(res).not.toBeNull();
    expect(res!.cleared).toMatchObject({ positions: 1, position_keys: 1, owner_epochs: 1, detectors: 1, alarms: 1, exits: 1, exit_payouts: 1, owed: 1, owed_logs: 1, attestations: 1, jobs: 1, log_retries: 1 });
    for (const t of contractTables) expect([t, await n(t)]).toEqual([t, 0]);
    // Exit work goes, alert and ops jobs stay.
    expect(await n("jobs", "kind='exit'")).toBe(0);
    expect(await n("jobs", "kind IN ('alert','ops')")).toBe(2);
    // The router and alarms logs restart at the new START_BLOCK, one block early. Their remembered hashes go.
    // The cursors are named for the contract they follow, and the old ones (named for v1 or not at all) are gone.
    expect((await r.cursor(routerCursor(V2.router)))).toBe(4_999n);
    expect((await r.cursor(alarmsCursor(V2.alarmBook)))).toBe(4_999n);
    expect((await db.query<{ name: string }>(`SELECT name FROM cursors ORDER BY name`)).map((x) => x.name)).toEqual(["alarms", alarmsCursor(V2.alarmBook), "payments", "router", routerCursor(V2.router)].sort());
    // The plain names older code reads are parked past any head, so an old copy still running reads nothing.
    expect(await r.cursor("router")).toBe(PARKED_CURSOR);
    expect(await r.cursor("alarms")).toBe(PARKED_CURSOR);
    const reader = "(source='router' OR source='alarms' OR source LIKE 'router@%' OR source LIKE 'alarms@%')";
    expect(await n("block_hashes", reader)).toBe(0);
    expect(await n("log_touches", reader)).toBe(0);
    expect(await n("reorg_recheck", reader)).toBe(0);
    // The payments reader is not touched.
    expect((await r.cursor("payments"))).toBe(900n);
    expect(await n("block_hashes", "source='payments'")).toBe(1);
    expect(await n("log_touches", "source='payments'")).toBe(1);
    expect(await n("reorg_recheck", "source='payments'")).toBe(1);
    // Nothing about people or chats moved.
    expect({ plans: await n("plans"), pay: await n("plan_payments"), follows: await n("vault_follows"), feed: await n("feed_items"), signals: await n("signals"), cards: await n("risk_cards"), snaps: await n("vault_snaps"), sent: await n("sent_alerts") }).toEqual(before);
    expect(await r.paidUntil(OWNER)).toBe(4_000_000_000);
    // The new addresses are stored.
    expect((await db.query<{ key: string; value: string }>(`SELECT key, value FROM meta ORDER BY key`))).toEqual([{ key: "alarm_book", value: V2.alarmBook }, { key: "router", value: V2.router }]);
  });

  test("a second start on the same addresses does nothing, and state written since is kept", async () => {
    await seed();
    await db.query(`INSERT INTO meta (key, value) VALUES ('router',$1), ('alarm_book',$2)`, [V1.router, V1.alarmBook]);
    expect(await switchContracts(db, V2, GO.router)).not.toBeNull();
    await r.upsertPosition({ posId: POS, owner: OWNER, adapter: V2.router, target: V2.alarmBook, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 5_100n, termsHash: "t", keys: [KEY] });
    await r.setCursor(routerCursor(V2.router), 5_200n);
    expect(await switchContracts(db, V2, GO.router)).toBeNull();
    expect(await switchContracts(db, { ...V2, router: V2.router.toUpperCase().replace("0X", "0x") })).toBeNull(); // case does not matter
    expect(await n("positions")).toBe(1);
    expect(await r.cursor(routerCursor(V2.router))).toBe(5_200n);
  });

  test("v1 rows with no stored addresses (a database from before this existed) are cleared too", async () => {
    await seed();
    const res = await switchContracts(db, V2, GO.router);
    expect(res).not.toBeNull();
    expect(res!.from).toEqual({ router: null, alarmBook: null });
    expect(await n("positions")).toBe(0);
    expect(await r.paidUntil(OWNER)).toBe(4_000_000_000);
    expect(await switchContracts(db, V2, GO.router)).toBeNull();
  });

  test("a new database just remembers the addresses and clears nothing", async () => {
    expect(await switchContracts(db, V2, GO.router)).toBeNull();
    expect(await n("meta")).toBe(2);
    expect(await r.cursor(routerCursor(V2.router))).toBeNull();
    // The payments cursor alone is not contract state either.
    await db.query(`DELETE FROM meta`);
    await r.setCursor("payments", 10n);
    expect(await switchContracts(db, V2, GO.router)).toBeNull();
    expect(await r.cursor("payments")).toBe(10n);
  });

  test("a START_BLOCK of 0 resets to block 0, not below it", async () => {
    await seed();
    await switchContracts(db, { ...V2, startBlock: 0n }, GO.router);
    expect(await r.cursor(routerCursor(V2.router))).toBe(0n);
  });

  test("two services starting at once switch only once", async () => {
    await seed();
    await db.query(`INSERT INTO meta (key, value) VALUES ('router',$1), ('alarm_book',$2)`, [V1.router, V1.alarmBook]);
    // Separate connections when there is a real server, as the services have.
    const url = process.env.TEST_DATABASE_URL;
    const dbs = url ? Array.from({ length: 7 }, () => postgres(url, 2)) : [db, db];
    const results = await Promise.all(dbs.map((d) => switchContracts(d, V2, GO.router)));
    expect(results.filter((x) => x !== null)).toHaveLength(1);
    expect(await n("positions")).toBe(0);
    expect(await r.paidUntil(OWNER)).toBe(4_000_000_000);
  });

  test("the message says what was cleared, with no URLs", async () => {
    await seed();
    const text = switchText((await switchContracts(db, V2, GO.router))!);
    expect(text).toContain("positions 1");
    expect(text).toContain("Plans, payments and follows kept");
    expect(text).not.toMatch(/https?:/);
  });
});
