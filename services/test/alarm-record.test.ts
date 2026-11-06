import { describe, expect, test } from "bun:test";
import { createApi } from "../src/api/server";
import { presetsFor } from "../src/api/presets";
import { alarmsPlugin, redact } from "../src/plugins/alarms";
import type { BlockTime } from "../src/plugins/exits";
import { repo } from "../src/store/repo";
import { freshDb } from "./db";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000a2";
const X = "0x00000000000000000000000000000000000000a9"; // not listed
const OWNER = "0x00000000000000000000000000000000000000b2";
const CALLER = "0x00000000000000000000000000000000000000c3";
const TOKEN = "0x00000000000000000000000000000000000000d4";
const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";
const W3 = "0x3333333333333333333333333333333333333333";
const ZERO32 = "0x" + "0".repeat(64);
const EV = "0x" + "ee".repeat(32);
const TOKEN_HEALTH = "demo-health-token-0123";
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const pos = (n: number) => "0x" + n.toString(16).padStart(64, "2");

const LOSS_A = presetsFor(A as `0x${string}`)[0]!.key; // Vault loss, a hard rule
const QUORUM_A = presetsFor(A as `0x${string}`)[1]!.key; // Exploit confirmed, two watchers
const BOTH_A = presetsFor(A as `0x${string}`).find((p) => p.name === "Vault drain + confirmation")!.key;
const LOSS_B = presetsFor(B as `0x${string}`)[0]!.key;
const LOSS_X = presetsFor(X as `0x${string}`)[0]!.key;

/** Blocks are mined 2 seconds apart, starting at 1000. */
const clock: BlockTime = async (b) => 1000 + b * 2;
const NOW = 700_000;

async function setup(opts: { token?: string | undefined; now?: { t: number } } = {}) {
  const db = await freshDb();
  const r = repo(db);
  const clockNow = opts.now ?? { t: NOW };
  const app = createApi({
    db,
    repo: r,
    vaults: async () => [
      { address: A as `0x${string}`, name: "Sample Vault", chainId: 4663, asset: "USDG" },
      { address: B as `0x${string}`, name: "Second Vault", chainId: 4663, asset: "USDG" },
    ],
    liveAlarms: async () => [],
    watchers: [W1, W2] as `0x${string}`[],
    alarmBook: "0x0000000000000000000000000000000000000001",
    chainId: 4663,
    now: () => clockNow.t,
    healthToken: "token" in opts ? opts.token : TOKEN_HEALTH,
    plugins: [alarmsPlugin(clock)],
  });
  const get = async (path = "/alarms/record") => (await app.request(path)).json() as Promise<any>;
  const detector = (key: string, kind: number, target: string, b = "") =>
    db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,$2,$3,0,0,'',$4)`, [key, kind, target, b]);
  const position = (n: number, target: string, keys: string[], armedBlock = 1n) =>
    r.upsertPosition({ posId: pos(n), owner: OWNER, adapter: "0x" + "0".repeat(40), target, tokenId: 1n, harbour: 0, maxSlipBps: 50, epoch: 0n, block: armedBlock, termsHash: ZERO32, keys });
  const exit = async (id: number, block: number, key: string, amount = 5_000_000n, posN = 1) => {
    await r.recordExit({ exitId: BigInt(id), posId: pos(posN), owner: OWNER, caller: CALLER, alarmKey: key, viaAlarm: true, tx: tx(id), block: BigInt(block) });
    await r.recordPayout({ exitId: BigInt(id), tx: tx(id), logIndex: 0, token: TOKEN, amount, swapped: false });
  };
  const review = (body: unknown, auth: string | null = `Bearer ${TOKEN_HEALTH}`) =>
    app.request("/alarms/review", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
  return { db, r, app, get, detector, position, exit, review, clockNow };
}
type S = Awaited<ReturnType<typeof setup>>;

/** Four alarms on listed vaults, one on an unlisted vault, and the exits that followed some of them. */
async function seed(s: S) {
  await s.db.query(`INSERT INTO risk_cards (target, numbers, text, updated_at) VALUES ($1,$2::text::jsonb,'',0)`, [A, JSON.stringify({ name: "Sample Vault", assetSymbol: "USDG", assetDecimals: 6 })]);
  await s.detector(LOSS_A, 1, A);
  await s.detector(QUORUM_A, 5, A);
  await s.detector(BOTH_A, 6, A, QUORUM_A);
  await s.detector(LOSS_B, 1, B);
  await s.detector(LOSS_X, 1, X);
  await s.position(1, A, [LOSS_A]);
  await s.position(2, A, [LOSS_A]);
  await s.position(3, B, [LOSS_B]);
  // 1. A hard-rule alarm with two exits, 40 s and 60 s later (block b is mined at 1000 + 2b).
  await s.r.recordAlarm(LOSS_A, 1000, tx(901), "0x", 10n);
  await s.exit(1, 20, LOSS_A, 5_000_000n, 1);
  await s.exit(2, 30, LOSS_A, 7_000_000n, 2);
  // 2. A quorum alarm: two approved watchers and one unapproved one signed. Nobody had it armed.
  await s.r.recordAlarm(QUORUM_A, 5000, tx(902), EV, 11n);
  for (const w of [W1, W2, W3]) await s.db.query(`INSERT INTO attestations (key, evidence_hash, deadline, signer, sig) VALUES ($1,$2,9999999,$3,'0x')`, [QUORUM_A, EV, w]);
  // 3. A hard-rule alarm with armed positions and no exit, long closed.
  await s.r.recordAlarm(LOSS_A, 200_000, tx(903), "0x", 12n);
  // 4. An armed alarm on the other vault, fired an hour ago: no exit yet, still inside its 24 hours.
  await s.r.recordAlarm(LOSS_B, 696_400, tx(904), "0x", 13n);
  // 5. An alarm on a vault that is not listed.
  await s.r.recordAlarm(LOSS_X, 250_000, tx(905), "0x", 14n);
}

describe("GET /alarms/record", () => {
  test("zero state: nothing fired, honest empty numbers", async () => {
    const s = await setup();
    const body = await s.get();
    expect(body).toEqual({
      summary: {
        fired: { last7d: 0, last30d: 0, all: 0 },
        alarmsWithExit: 0,
        exits: 0,
        medianSecondsToExit: null,
        noExit: 0,
        noArmedPositions: 0,
        falseAlarms: { falseAlarm: 0, confirmed: 0, unreviewed: 0 },
      },
      vaults: [
        { address: A, name: "Sample Vault" },
        { address: B, name: "Second Vault" },
      ],
      total: 0,
      alarms: [],
      next: null,
    });
  });

  test("lists alarms on listed vaults with what followed, and summarises them", async () => {
    const s = await setup();
    await seed(s);
    const body = await s.get();
    expect(body.alarms.map((a: any) => [a.firedAt, a.outcome, a.open])).toEqual([
      [696_400, "no_exit", true],
      [200_000, "no_exit", false],
      [5000, "no_armed_positions", false],
      [1000, "exited", false],
    ]);
    const [open, , quorum, hard] = body.alarms;
    expect(hard).toEqual({
      key: LOSS_A,
      firedAt: 1000,
      vault: { address: A, name: "Sample Vault" },
      alarm: { name: "Vault loss", kind: "SHARE_DROP", rule: "hard", signers: [], evidence: null, tx: tx(901) },
      outcome: "exited",
      open: false,
      exits: {
        count: 2,
        firstAfterSeconds: 40,
        returned: [{ token: TOKEN, amount: "12000000", symbol: "USDG", decimals: 6 }],
        links: [
          { tx: tx(1), ranAt: 1040 },
          { tx: tx(2), ranAt: 1060 },
        ],
      },
      review: { verdict: "unreviewed", note: "", at: null },
    });
    expect(quorum.alarm).toEqual({ name: "Exploit confirmed", kind: "QUORUM", rule: "quorum", signers: ["0x1111…1111", "0x2222…2222"], evidence: EV, tx: tx(902) });
    expect(quorum.exits).toEqual({ count: 0, firstAfterSeconds: null, returned: [], links: [] });
    expect(open.vault.name).toBe("Second Vault");
    expect(body.summary).toEqual({
      fired: { last7d: 2, last30d: 4, all: 4 },
      alarmsWithExit: 1,
      exits: 2,
      medianSecondsToExit: 40,
      noExit: 1, // the open one is not a miss yet
      noArmedPositions: 1,
      falseAlarms: { falseAlarm: 0, confirmed: 0, unreviewed: 4 },
    });
  });

  test("a combined alarm shows the watchers that signed its confirmation part", async () => {
    const s = await setup();
    await seed(s);
    await s.r.recordAlarm(BOTH_A, 7000, tx(906), EV, 15n);
    await s.db.query(`INSERT INTO attestations (key, evidence_hash, deadline, signer, sig) VALUES ($1,$2,9999999,$3,'0x')`, [QUORUM_A, "0x" + "dd".repeat(32), W1]);
    const row = (await s.get("/alarms/record?limit=100")).alarms.find((a: any) => a.key === BOTH_A);
    expect(row.alarm).toMatchObject({ name: "Vault drain + confirmation", kind: "BOTH", rule: "quorum", signers: ["0x1111…1111", "0x2222…2222"] });
  });

  test("an exit more than 24 hours after the alarm does not count as following it", async () => {
    const s = await setup();
    await seed(s);
    await s.r.recordAlarm(LOSS_A, 400_000, tx(907), "0x", 16n);
    await s.exit(3, (400_000 + 90_000 - 1000) / 2, LOSS_A, 1n, 1); // 90 000 s later
    s.clockNow.t = 900_000;
    const rows = (await s.get("/alarms/record?limit=100")).alarms;
    expect(rows.find((a: any) => a.firedAt === 400_000)).toMatchObject({ outcome: "no_exit", open: false });
  });

  test("an exit whose block time cannot be read yet is still attached, by block number", async () => {
    const down: BlockTime = async () => null;
    const db = await freshDb();
    const r = repo(db);
    const app = createApi({
      db, repo: r, vaults: async () => [{ address: A as `0x${string}`, name: "Sample Vault", chainId: 4663, asset: "USDG" }], liveAlarms: async () => [], watchers: [],
      alarmBook: "0x0000000000000000000000000000000000000001", chainId: 4663, now: () => NOW, plugins: [alarmsPlugin(down)],
    });
    await db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,1,$2,0,0,'','')`, [LOSS_A, A]);
    await r.recordAlarm(LOSS_A, 1000, tx(901), "0x", 10n);
    await r.recordExit({ exitId: 1n, posId: pos(1), owner: OWNER, caller: CALLER, alarmKey: LOSS_A, viaAlarm: true, tx: tx(1), block: 20n });
    const body = (await (await app.request("/alarms/record")).json()) as any;
    expect(body.alarms[0]).toMatchObject({ outcome: "exited", exits: { count: 1, firstAfterSeconds: null } });
    expect(body.summary.medianSecondsToExit).toBeNull();
  });

  test("filters by vault and by outcome", async () => {
    const s = await setup();
    await seed(s);
    expect((await s.get(`/alarms/record?vault=${B.toUpperCase().replace("0X", "0x")}`)).alarms.map((a: any) => a.firedAt)).toEqual([696_400]);
    const exited = await s.get("/alarms/record?outcome=exited");
    expect(exited.alarms.map((a: any) => a.firedAt)).toEqual([1000]);
    expect(exited.total).toBe(1);
    expect(exited.summary.fired.all).toBe(4); // the summary never narrows
    expect((await s.get(`/alarms/record?vault=${A}&outcome=no_exit`)).alarms.map((a: any) => a.firedAt)).toEqual([200_000]);
  });

  test("pages with limit and before, newest first", async () => {
    const s = await setup();
    await seed(s);
    const one = await s.get("/alarms/record?limit=3");
    expect(one.alarms.map((a: any) => a.firedAt)).toEqual([696_400, 200_000, 5000]);
    expect(one.next).toBe(`5000:${QUORUM_A}`);
    const two = await s.get(`/alarms/record?limit=3&before=${one.next}`);
    expect(two.alarms.map((a: any) => a.firedAt)).toEqual([1000]);
    expect(two.next).toBeNull();
    const past = await s.get(`/alarms/record?before=1000:${LOSS_A}`);
    expect(past.alarms).toEqual([]);
    expect(past.next).toBeNull();
  });

  test("caps the page size and rejects bad queries", async () => {
    const s = await setup();
    for (const bad of ["limit=abc", "limit=-1", "before=x", "before=5:1;drop", "vault=nope", "outcome=lost"]) {
      expect((await s.app.request(`/alarms/record?${bad}`)).status).toBe(400);
    }
    expect((await s.app.request("/alarms/record?limit=0")).status).toBe(200);
    expect((await s.app.request("/alarms/record?limit=5000")).status).toBe(200);
  });

  test("answers are cached for 60 seconds and say so", async () => {
    const s = await setup();
    await seed(s);
    const res = await s.app.request("/alarms/record");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect((await s.get()).summary.fired.all).toBe(4);
    await s.r.recordAlarm(LOSS_B, 699_000, tx(908), "0x", 17n);
    s.clockNow.t = NOW + 59;
    expect((await s.get()).summary.fired.all).toBe(4);
    s.clockNow.t = NOW + 60;
    expect((await s.get()).summary.fired.all).toBe(5);
  });

  test("never shows an owner, caller, or a full watcher address", async () => {
    const s = await setup();
    await seed(s);
    await s.review({ key: LOSS_A, firedAt: 1000, verdict: "confirmed", note: `checked with ${OWNER} and ${W1}` });
    const text = (await (await s.app.request("/alarms/record?limit=100")).text()).toLowerCase();
    for (const addr of [OWNER, CALLER, W1, W2, W3]) expect(text).not.toContain(addr);
    expect(text).not.toMatch(/"(owner|caller|signer)"/);
    expect(text).toContain("[address removed]");
  });
});

describe("POST /alarms/review", () => {
  test("refuses everyone without the operator token, and everyone when no token is set", async () => {
    const s = await setup();
    await seed(s);
    const body = { key: LOSS_A, firedAt: 1000, verdict: "false_alarm" };
    expect((await s.review(body, null)).status).toBe(403);
    expect((await s.review(body, "Bearer wrong-token-0123456789")).status).toBe(403);
    expect((await s.review(body, TOKEN_HEALTH)).status).toBe(403); // no Bearer prefix
    expect((await s.get()).summary.falseAlarms.falseAlarm).toBe(0);
    const open = await setup({ token: undefined });
    await seed(open);
    expect((await open.review(body, "Bearer undefined")).status).toBe(403);
    expect((await open.review(body, "Bearer ")).status).toBe(403);
    expect((await open.review(body, null)).status).toBe(403);
  });

  test("a marked verdict changes the counts, with its note, and unreviewed is never counted as correct", async () => {
    const s = await setup();
    await seed(s);
    expect((await s.review({ key: LOSS_A, firedAt: 200_000, verdict: "false_alarm", note: "Price feed glitch, no loss followed" })).status).toBe(200);
    expect((await s.review({ key: LOSS_A, firedAt: 1000, verdict: "confirmed" })).status).toBe(200);
    const body = await s.get("/alarms/record?limit=100");
    expect(body.summary.falseAlarms).toEqual({ falseAlarm: 1, confirmed: 1, unreviewed: 2 });
    const by = (t: number) => body.alarms.find((a: any) => a.firedAt === t).review;
    expect(by(200_000)).toEqual({ verdict: "false_alarm", note: "Price feed glitch, no loss followed", at: NOW });
    expect(by(1000)).toMatchObject({ verdict: "confirmed", note: "" });
    expect(by(5000).verdict).toBe("unreviewed");
    // Changing the verdict, and putting it back, replaces the row.
    await s.review({ key: LOSS_A, firedAt: 200_000, verdict: "unreviewed" });
    expect((await s.get()).summary.falseAlarms).toEqual({ falseAlarm: 0, confirmed: 1, unreviewed: 3 });
  });

  test("rejects a bad body, an unknown alarm, and a note that is too long", async () => {
    const s = await setup();
    await seed(s);
    expect((await s.review({ key: LOSS_A, firedAt: 1000, verdict: "fine" })).status).toBe(400);
    expect((await s.review({ key: "0x12", firedAt: 1000, verdict: "confirmed" })).status).toBe(400);
    expect((await s.review({ key: LOSS_A, firedAt: 1000, verdict: "confirmed", extra: 1 })).status).toBe(400);
    expect((await s.review({ key: LOSS_A, firedAt: 1000, verdict: "confirmed", note: "x".repeat(501) })).status).toBe(400);
    expect((await s.review({ key: LOSS_A, firedAt: 4242, verdict: "confirmed" })).status).toBe(404);
    expect((await s.app.request("/alarms/review", { method: "POST", headers: { authorization: `Bearer ${TOKEN_HEALTH}` }, body: "not json" })).status).toBe(400);
    expect((await s.app.request("/alarms/review", { method: "GET" })).status).toBe(404);
  });

  test("redacts wallet addresses from a note", () => {
    expect(redact(`seen at ${OWNER}, ok`)).toBe("seen at [address removed], ok");
    expect(redact("hash " + tx(5))).toBe("hash " + tx(5));
  });
});
