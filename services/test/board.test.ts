import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { buildBoard, median, toMicro, type ArmedPosition, type ExitRecord } from "../src/api/board";
import { createApi } from "../src/api/server";
import type { Db } from "../src/store/db";
import { repo } from "../src/store/repo";
import { freshDb } from "./db";

const V1 = "0x00000000000000000000000000000000000000a1";
const V2 = "0x00000000000000000000000000000000000000a2";
const STRANGER = "0x00000000000000000000000000000000000000ff";
const vaults = [
  { address: V1, name: "Sample Vault One", assetDecimals: 6 },
  { address: V2, name: "Sample Vault Two", assetDecimals: 6 },
];
const E18 = 10n ** 18n;
const NOW = 2_000_000;
const url = (tx: string) => `https://explorer.invalid/tx/${tx}`;
const empty = { now: NOW, vaults, positions: [], sharePrice: new Map<string, bigint>(), exits: [], txUrl: url };
const pos = (owner: string, target: string, shares: bigint | null): ArmedPosition => ({ owner, target, shares });
const exit = (n: number, o: Partial<ExitRecord> = {}): ExitRecord => ({
  exitId: String(n), at: NOW - 100 * n, tx: `0xtx${n}`, target: V1, alarm: "Vault loss", firedAt: NOW - 100 * n - 10, paid: [{ amount: 1_000_000n, decimals: 6 }], ...o,
});

describe("board maths", () => {
  test("zero state: no positions, no exits, nothing to divide by", () => {
    const b = buildBoard(empty);
    expect(b.armed).toEqual({ value: 0, positions: 0, wallets: 0, unpriced: 0, topVaults: [] });
    expect(b.exits.allTime).toEqual({ count: 0, value: 0 });
    expect(b.exits.secondsToExit).toEqual({ fastest: null, median: null, samples: 0 });
    expect(b.exits.latest).toEqual([]);
  });

  test("armed value is shares times share price, per vault, and wallets are counted once", () => {
    const b = buildBoard({
      ...empty,
      sharePrice: new Map([[V1, 1_050_000n], [V2, 1_000_000n]]), // convertToAssets(1e18) of a 6-decimal asset: 1.05 and 1.00 per share
      positions: [pos("0xA", V1, 100n * E18), pos("0xa", V2, 50n * E18), pos("0xb", V1, 10n * E18)],
    });
    // 110 shares * 1.05 = 115.50, plus 50 * 1.00
    expect(b.armed.value).toBe(165.5);
    expect(b.armed.positions).toBe(3);
    expect(b.armed.wallets).toBe(2);
    expect(b.armed.topVaults.map((v) => [v.name, v.value, v.positions])).toEqual([["Sample Vault One", 115.5, 2], ["Sample Vault Two", 50, 1]]);
  });

  test("top vaults: five at most, biggest first", () => {
    const many = Array.from({ length: 7 }, (_, n) => ({ address: `0x${String(n).padStart(40, "0")}`, name: `V${n}`, assetDecimals: 6 }));
    const b = buildBoard({
      ...empty,
      vaults: many,
      sharePrice: new Map(many.map((v) => [v.address, 1_000_000n])),
      positions: many.map((v, n) => pos(`0x${n}`, v.address, BigInt(n + 1) * E18)),
    });
    expect(b.armed.topVaults.map((v) => v.name)).toEqual(["V6", "V5", "V4", "V3", "V2"]);
  });

  test("a position with nothing left to exit is not armed; unread and unpriced ones count but add no value", () => {
    const b = buildBoard({
      ...empty,
      sharePrice: new Map([[V1, 1_000_000n]]),
      positions: [pos("0xa", V1, 0n), pos("0xb", V1, 5n * E18), pos("0xc", V1, null), pos("0xd", V2, 9n * E18)],
    });
    expect(b.armed.positions).toBe(3);
    expect(b.armed.unpriced).toBe(2);
    expect(b.armed.value).toBe(5);
    expect(b.armed.topVaults.find((v) => v.name === "Sample Vault Two")?.value).toBeNull();
  });

  test("value is null, not zero, when no balance could be read", () => {
    const b = buildBoard({ ...empty, sharePrice: new Map([[V1, 1_000_000n]]), positions: [pos("0xa", V1, null)] });
    expect(b.armed.value).toBeNull();
    expect(b.armed.positions).toBe(1);
  });

  test("a vault that is not on the list never adds value, positions or exits", () => {
    const b = buildBoard({
      ...empty,
      sharePrice: new Map([[STRANGER, 10n ** 30n]]),
      positions: [pos("0xa", STRANGER, 10n ** 30n)],
      exits: [exit(1, { target: STRANGER })],
    });
    expect(b.armed.value).toBe(0);
    expect(b.armed.positions).toBe(0);
    expect(b.exits.allTime.count).toBe(0);
  });

  test("asset decimals: an 18-decimal asset is scaled down to dollars", () => {
    const b = buildBoard({ ...empty, vaults: [{ address: V1, name: "Wide", assetDecimals: 18 }], sharePrice: new Map([[V1, 2n * E18]]), positions: [pos("0xa", V1, 3n * E18)] }); // an 18-decimal asset: 2.0 per share
    expect(b.armed.value).toBe(6);
    expect(toMicro(5n, 6)).toBe(5n);
    expect(toMicro(5n, 8)).toBe(0n);
    expect(toMicro(5n, 2)).toBe(50_000n);
  });

  test("exit windows, value returned and the latest five", () => {
    const day = 86_400;
    const exits = [
      exit(1, { at: NOW - 60 }),
      exit(2, { at: NOW - day - 1 }),
      exit(3, { at: NOW - 6 * day }),
      exit(4, { at: NOW - 8 * day, paid: [{ amount: 2_500_000n, decimals: 6 }, { amount: 500_000n, decimals: 6 }] }),
      exit(5, { at: null, firedAt: null }),
      exit(6, { at: NOW - 30 }),
      exit(7, { at: NOW - 10 }),
    ];
    const b = buildBoard({ ...empty, exits });
    expect(b.exits.last24h).toEqual({ count: 3, value: 3 });
    expect(b.exits.last7d).toEqual({ count: 5, value: 5 });
    expect(b.exits.allTime).toEqual({ count: 7, value: 9 });
    expect(b.exits.latest.map((e) => e.tx)).toEqual(["0xtx7", "0xtx6", "0xtx1", "0xtx2", "0xtx3"]);
    expect(b.exits.latest[0]).toEqual({ vault: "Sample Vault One", alarm: "Vault loss", secondsToExit: 700, amount: 1, at: NOW - 10, tx: "0xtx7", txUrl: url("0xtx7") });
    // No wallet anywhere in the answer.
    expect(JSON.stringify(b)).not.toContain("owner");
  });

  test("time from alarm to exit: fastest and median, ignoring gaps that are not real", () => {
    const at = (n: number, gap: number | null) => exit(n, { at: NOW - n, firedAt: gap === null ? null : NOW - n - gap });
    const b = buildBoard({ ...empty, exits: [at(1, 6), at(2, 30), at(3, 12), at(4, null), at(5, 90_000), at(6, -5)] });
    expect(b.exits.secondsToExit).toEqual({ fastest: 6, median: 12, samples: 3 });
    expect(median([4, 8])).toBe(4);
    expect(median([])).toBeNull();
  });
});

describe("GET /board", () => {
  async function setup() {
    const db: Db = await freshDb();
    const q = (s: string, p: unknown[] = []) => db.query(s, p);
    const clock = { t: NOW };
    let reads = 0;
    const app = createApi({
      db, repo: repo(db), chainId: 4663, now: () => clock.t, watchers: [], alarmBook: "0x0000000000000000000000000000000000000001", liveAlarms: async () => [],
      vaults: async () => [{ address: V1 as Address, name: "Sample Vault One", chainId: 4663, asset: "USDG" }],
      exitableShares: async (r) => (reads++, r.map((x) => (x.owner === "0xaa" ? 100n * E18 : 40n * E18))),
      rateLimit: { perMin: 3, proxyHops: 0 },
    });
    return { q, clock, app, reads: () => reads };
  }
  type Q = Awaited<ReturnType<typeof setup>>["q"];
  const arm = (q: Q, id: string, owner: string, target: string, active = true) =>
    q(`INSERT INTO positions (pos_id, owner, adapter, target, token_id, harbour, max_slip_bps, epoch, active, armed_block, terms_hash) VALUES ($1,$2,'0xad',$3,0,0,0,0,$4,1,'0xh')`, [id, owner, target, active]);

  test("zero state answers 200 with zeros", async () => {
    const { app } = await setup();
    const r = await app.request("/board");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.armed.positions).toBe(0);
    expect(b.armed.value).toBe(0);
    expect(b.exits.secondsToExit.fastest).toBeNull();
    expect(r.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("shape and numbers from the database and the chain reader", async () => {
    const { q, app } = await setup();
    await q(`INSERT INTO risk_cards (target, numbers, text, updated_at) VALUES ($1, '{"assetDecimals":6}', '', 0)`, [V1]);
    await q(`INSERT INTO vault_snaps (target, t, total_assets, share_price) VALUES ($1,$2,0,$3),($1,$4,0,$5)`, [V1, NOW - 600, '500000', NOW - 60, '1100000']);
    await arm(q, "p1", "0xaa", V1);
    await arm(q, "p2", "0xbb", V1);
    await arm(q, "p3", "0xcc", V1, false);
    await arm(q, "p4", "0xdd", STRANGER);
    await q(`INSERT INTO detectors (key, kind, target) VALUES ('k1', 1, $1)`, [V1]);
    await q(`INSERT INTO alarms (key, fired_at, tx, evidence) VALUES ('k1', $1, '0xa', ''), ('k1', $2, '0xb', '')`, [NOW - 5_000, NOW - 500]);
    await q(`INSERT INTO exits (exit_id, pos_id, owner, caller, alarm_key, via_alarm, tx, block, at) VALUES (1,'p1','0xaa','0xk','k1',true,'0xexit1',9,$1)`, [NOW - 494]);
    await q(`INSERT INTO exit_payouts (exit_id, tx, log_index, token, amount, swapped) VALUES (1,'0xexit1',0,'0xusdg',250000000,false)`);
    const b = await (await app.request("/board")).json();
    // (100 + 40) shares * 1.10 each, from the newest snap; the inactive position and the unlisted vault are out.
    expect(b.armed).toEqual({ value: 154, positions: 2, wallets: 2, unpriced: 0, topVaults: [{ vault: V1, name: "Sample Vault One", value: 154, positions: 2 }] });
    expect(b.exits.allTime).toEqual({ count: 1, value: 250 });
    expect(b.exits.secondsToExit).toEqual({ fastest: 6, median: 6, samples: 1 });
    expect(b.exits.latest).toHaveLength(1);
    expect(b.exits.latest[0]).toMatchObject({ vault: "Sample Vault One", alarm: "Vault loss", secondsToExit: 6, amount: 250, tx: "0xexit1" });
    expect(Object.keys(b).sort()).toEqual(["armed", "exits", "generatedAt"]);
    expect(JSON.stringify(b)).not.toMatch(/0xaa|0xbb|0xcc|0xdd/);
  });

  test("answers are cached for 60 seconds, then read again", async () => {
    const { q, app, clock, reads } = await setup();
    await arm(q, "p1", "0xaa", V1);
    await app.request("/board");
    clock.t += 59;
    await app.request("/board");
    expect(reads()).toBe(1);
    clock.t += 1;
    await app.request("/board");
    expect(reads()).toBe(2);
  });

  test("shares the API's per-address read limit", async () => {
    const { app } = await setup();
    const codes: number[] = [];
    for (let n = 0; n < 5; n++) codes.push((await app.request("/board")).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
});
