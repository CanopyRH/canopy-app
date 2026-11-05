import { describe, expect, test } from "bun:test";
import { createApi } from "../src/api/server";
import { exitsPlugin, type BlockTime } from "../src/plugins/exits";
import { repo } from "../src/store/repo";
import { freshDb } from "./db";

const VAULT = "0x00000000000000000000000000000000000000a1";
const OWNER = "0x00000000000000000000000000000000000000b2";
const CALLER = "0x00000000000000000000000000000000000000c3";
const TOKEN = "0x00000000000000000000000000000000000000d4";
const KEY = "0x" + "11".repeat(32);
const POS = "0x" + "22".repeat(32);
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");

/** Blocks are mined 2 seconds apart, starting at 1000. */
const clock: BlockTime = async (b) => 1000 + b * 2;

async function setup(blockTime: BlockTime = clock, now = () => 0) {
  const db = await freshDb();
  const r = repo(db);
  const app = createApi({
    db, repo: r, vaults: async () => [], liveAlarms: async () => [], watchers: [],
    alarmBook: "0x0000000000000000000000000000000000000001", chainId: 4663, now, plugins: [exitsPlugin(blockTime)],
  });
  const seedExit = async (id: number, block: number, o: { viaAlarm?: boolean; key?: string; amount?: bigint; swapped?: boolean } = {}) => {
    await r.recordExit({ exitId: BigInt(id), posId: POS, owner: OWNER, caller: CALLER, alarmKey: o.key ?? KEY, viaAlarm: o.viaAlarm ?? true, tx: tx(id), block: BigInt(block) });
    await r.recordPayout({ exitId: BigInt(id), tx: tx(id), logIndex: 0, token: TOKEN, amount: o.amount ?? 5_000_000n, swapped: o.swapped ?? false });
  };
  const get = async (path = "/exits") => (await app.request(path)).json() as Promise<any>;
  return { db, r, app, seedExit, get };
}

async function seedBase(s: Awaited<ReturnType<typeof setup>>) {
  await s.r.upsertPosition({ posId: POS, owner: OWNER, adapter: "0x" + "0".repeat(40), target: VAULT, tokenId: 1n, harbour: 0, maxSlipBps: 50, epoch: 0n, block: 1n, termsHash: "0x" + "0".repeat(64), keys: [KEY] });
  await s.db.query(`INSERT INTO risk_cards (target, numbers, text, updated_at) VALUES ($1,$2::text::jsonb,'',0)`, [VAULT, JSON.stringify({ name: "Sample Vault", assetSymbol: "USDG", assetDecimals: 6 })]);
  await s.db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,0,$2,0,0,'','')`, [KEY, VAULT]);
}

describe("GET /exits", () => {
  test("an empty log answers with nothing and no times", async () => {
    const s = await setup();
    expect(await s.get()).toEqual({ summary: { total: 0, timed: 0, medianSeconds: null, longestSeconds: null }, exits: [], next: null });
  });

  test("lists an exit with its vault, alarm, timing, payout and transaction", async () => {
    const s = await setup();
    await seedBase(s);
    await s.r.recordAlarm(KEY, 1100, tx(900), "0x");
    await s.seedExit(1, 50); // block 50 is mined at 1100, the moment the alarm fired
    const body = await s.get();
    expect(body.exits).toHaveLength(1);
    expect(body.exits[0]).toEqual({
      id: "1",
      vault: { address: VAULT, name: "Sample Vault" },
      alarm: { key: KEY, name: "a price alarm", firedAt: 1100 },
      ranAt: 1100,
      seconds: 0,
      paid: [{ token: TOKEN, amount: "5000000", symbol: "USDG", decimals: 6 }],
      tx: tx(1),
    });
  });

  test("never returns an owner or caller address anywhere", async () => {
    const s = await setup();
    await seedBase(s);
    await s.r.recordAlarm(KEY, 1000, tx(900), "0x");
    await s.seedExit(1, 60);
    const text = await (await s.app.request("/exits")).text();
    expect(text.toLowerCase()).not.toContain(OWNER);
    expect(text.toLowerCase()).not.toContain(CALLER);
    expect(text).not.toMatch(/owner|caller/i);
  });

  test("lists newest first and pages with before and limit", async () => {
    const s = await setup();
    await seedBase(s);
    await s.r.recordAlarm(KEY, 1000, tx(900), "0x");
    for (const id of [1, 2, 3, 4, 5]) await s.seedExit(id, 100 + id);
    const first = await s.get("/exits?limit=2");
    expect(first.exits.map((e: any) => e.id)).toEqual(["5", "4"]);
    expect(first.next).toBe("4");
    const second = await s.get(`/exits?limit=2&before=${first.next}`);
    expect(second.exits.map((e: any) => e.id)).toEqual(["3", "2"]);
    const last = await s.get(`/exits?limit=2&before=${second.next}`);
    expect(last.exits.map((e: any) => e.id)).toEqual(["1"]);
    expect(last.next).toBeNull();
    expect(last.summary.total).toBe(5);
  });

  test("caps the page size and rejects bad paging", async () => {
    const s = await setup();
    await seedBase(s);
    for (let id = 1; id <= 105; id++) await s.seedExit(id, id);
    expect((await s.get("/exits?limit=5000")).exits).toHaveLength(100);
    expect((await s.get("/exits?limit=0")).exits).toHaveLength(1);
    expect((await s.get("/exits")).exits).toHaveLength(20);
    for (const bad of ["limit=abc", "limit=-1", "before=x", "before=1;drop"]) expect((await s.app.request(`/exits?${bad}`)).status).toBe(400);
  });

  test("measures from the alarm firing before the exit and summarises the log", async () => {
    const s = await setup();
    await seedBase(s);
    // Exits run 10, 30 and 60 seconds after the alarm (block b is mined at 1000 + 2b).
    await s.r.recordAlarm(KEY, 1000, tx(900), "0x");
    await s.seedExit(1, 5); // 1010
    await s.seedExit(2, 15); // 1030
    await s.seedExit(3, 30); // 1060
    // A later firing of the same alarm does not change exits that ran before it.
    await s.r.recordAlarm(KEY, 5000, tx(901), "0x");
    const body = await s.get();
    expect(body.exits.map((e: any) => e.seconds)).toEqual([60, 30, 10]);
    expect(body.summary).toEqual({ total: 3, timed: 3, medianSeconds: 30, longestSeconds: 60 });
  });

  test("shows an always-true test alarm like any other exit", async () => {
    const s = await setup();
    await seedBase(s);
    const testKey = "0x" + "ee".repeat(32);
    await s.db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,1,$2,0,0,'','')`, [testKey, VAULT]);
    await s.r.recordAlarm(testKey, 1000, tx(902), "0x");
    await s.seedExit(7, 10, { key: testKey });
    const [e] = (await s.get()).exits;
    expect(e.alarm).toEqual({ key: testKey, name: "a vault loss alarm", firedAt: 1000 });
    expect(e.seconds).toBe(20);
  });

  test("an exit with no alarm row, or not run by an alarm, still lists", async () => {
    const s = await setup();
    await seedBase(s);
    await s.seedExit(1, 10, { key: "0x" + "99".repeat(32) }); // alarm never indexed
    await s.seedExit(2, 11, { viaAlarm: false });
    const body = await s.get();
    expect(body.exits[0].alarm).toBeNull();
    expect(body.exits[0].seconds).toBeNull();
    expect(body.exits[1].alarm).toEqual({ key: "0x" + "99".repeat(32), name: "an alarm", firedAt: null });
    expect(body.summary).toMatchObject({ total: 2, timed: 0, medianSeconds: null, longestSeconds: null });
  });

  test("a swapped payout does not borrow the vault's token symbol", async () => {
    const s = await setup();
    await seedBase(s);
    await s.seedExit(1, 10, { swapped: true });
    expect((await s.get()).exits[0].paid).toEqual([{ token: TOKEN, amount: "5000000", symbol: null, decimals: null }]);
  });

  test("an unknown vault still lists, without a name", async () => {
    const s = await setup();
    await s.seedExit(1, 10);
    expect((await s.get()).exits[0].vault).toBeNull();
    await s.r.upsertPosition({ posId: POS, owner: OWNER, adapter: "0x" + "0".repeat(40), target: VAULT, tokenId: 1n, harbour: 0, maxSlipBps: 50, epoch: 0n, block: 1n, termsHash: "0x" + "0".repeat(64), keys: [KEY] });
    expect((await s.get()).exits[0].vault).toEqual({ address: VAULT, name: null });
  });

  test("keeps working when block times can't be read, and tries again after a pause", async () => {
    let calls = 0;
    let t = 0;
    const flaky: BlockTime = async (b) => (++calls, calls <= 1 ? null : clock(b));
    const s = await setup(flaky, () => t);
    await seedBase(s);
    await s.r.recordAlarm(KEY, 1000, tx(900), "0x");
    await s.seedExit(1, 5);
    const down = await s.get();
    expect(down.exits[0].ranAt).toBeNull();
    expect(down.exits[0].seconds).toBeNull();
    expect(down.summary.total).toBe(1);
    await s.get(); // inside the pause: no new lookup
    expect(calls).toBe(1);
    t = 60;
    expect((await s.get()).exits[0].seconds).toBe(10);
  });

  test("looks each block up once and stores it", async () => {
    let calls = 0;
    const s = await setup(async (b) => (++calls, clock(b)));
    await seedBase(s);
    await s.seedExit(1, 5);
    await s.seedExit(2, 5);
    await s.get();
    await s.get();
    expect(calls).toBe(1);
  });

  test("is read-only", async () => {
    const s = await setup();
    expect((await s.app.request("/exits", { method: "POST" })).status).toBe(404);
  });
});
