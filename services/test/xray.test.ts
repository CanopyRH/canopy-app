import { beforeAll, describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { createApi } from "../src/api/server";
import { findBanned } from "../../tools/banned-words";
import { armedLines, changeLines, summary, XRAY } from "../src/copy/xray";
import { presetsFor } from "../src/api/presets";
import xrayPlugin, { sharePage, XRAY_TTL } from "../src/plugins/xray";
import type { Db } from "../src/store/db";
import { repo } from "../src/store/repo";
import { armedOn, amountText, cleanName, factsFrom, renderPng, renderSvg, wrap } from "../src/xray/xray";
import { freshDb } from "./db";
import { GATED_CARD, LAUNCH_CARD, LAUNCH_VAULT } from "./xray-fixtures";

const V = LAUNCH_VAULT.toLowerCase() as Address;
const BOOK = "0x0000000000000000000000000000000000000001" as Address;
const NONE = { positions: 0, presets: [] as string[] };
const PRESETS = presetsFor(V, V, { paused: true });
const KEY = (name: string) => PRESETS.find((p) => p.name === name)!.key;

/** The SVG without its embedded logo, so a base64 run can't look like an address. */
const bare = (svg: string) => svg.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/, "data:logo");

let db: Db;
let clock = { t: 10_000 };
beforeAll(async () => {
  db = await freshDb();
});

const api = (o: { perMin?: number } = {}) =>
  createApi({
    db, repo: repo(db), vaults: async () => [], liveAlarms: async () => [], watchers: [], alarmBook: BOOK, chainId: 4663, now: () => clock.t,
    plugins: [xrayPlugin], publicUrl: "https://api.example.test/", rateLimit: o.perMin ? { perMin: o.perMin, proxyHops: 1 } : undefined,
  });

const arm = async (n: number, keys: string[], opts: { active?: boolean; confirmed?: boolean } = {}) => {
  const posId = `0x${n.toString(16).padStart(64, "0")}`;
  await repo(db).upsertPosition({
    posId, owner: `0x${n.toString(16).padStart(40, "0")}`, adapter: "0x00000000000000000000000000000000000000ad", target: V, tokenId: 0n, harbour: 0,
    maxSlipBps: 50, epoch: 0n, block: 5n, termsHash: `0x${"11".repeat(32)}`, keys,
  });
  await db.query(`UPDATE positions SET confirmed=$2, active=$3 WHERE pos_id=$1`, [posId, opts.confirmed ?? true, opts.active ?? true]);
};

describe("card numbers", () => {
  test("liquid now, gates and counts come from the saved card", () => {
    const f = factsFrom(LAUNCH_CARD, { positions: 3, presets: ["Vault loss"] });
    expect(f).toMatchObject({ vault: V, name: "Steakhouse USDG", asset: "USDG", version: "v2", held: "4,210,377", idle: "1,052,594", liquidTenths: 249, curatorSet: true, penaltyZero: true, armed: 3 });
    expect(f.gates.map((g) => g.state)).toEqual(["given up", "given up", "given up"]);
    expect(changeLines(f)).toEqual(["Curator can change settings.", "Withdrawal gates: off, and locked off for good.", "Forced exit penalty: zero."]);
    expect(armedLines(f)).toEqual(["3 positions armed", "Alarms in use: Vault loss."]);
  });

  test("a gate that is on, one still open and one given up are told apart", () => {
    const f = factsFrom(GATED_CARD, NONE);
    expect(f.gates.map((g) => g.state)).toEqual(["on", "open", "given up"]);
    expect(changeLines(f)).toContain("Withdrawal gates: ON. Exits can be blocked.");
    const open = factsFrom({ ...GATED_CARD, gates: GATED_CARD.gates.slice(1) as never }, NONE);
    expect(changeLines(open)).toContain("Withdrawal gates: off, but the curator can turn them on.");
    expect(f.liquidTenths).toBe(0);
    expect(armedLines(f)).toEqual(["No positions armed on this vault yet."]);
  });

  test("a failed read shows as unknown, never as zero or safe", () => {
    const f = factsFrom({ ...LAUNCH_CARD, totalAssets: null, gates: LAUNCH_CARD.gates.map((g) => ({ ...g, abdicated: null })) as never, forceDeallocatePenaltyZero: null }, NONE);
    expect(f.held).toBeNull();
    expect(f.liquidTenths).toBeNull();
    expect(summary(f)).toContain("Liquid now: unknown");
    expect(changeLines(f)).toContain("Withdrawal gates: could not be read.");
  });

  test("a v1 vault has no gate lines", () => {
    const f = factsFrom({ ...LAUNCH_CARD, version: "v1" }, NONE);
    expect(f.gates).toEqual([]);
    expect(changeLines(f)).toContain("Share gates are checked on v2 vaults only.");
  });

  test("amounts are exact and names are cleaned", () => {
    expect(amountText("123456789012345678", 18)).toBe("0.12");
    expect(amountText("5000000", 6)).toBe("5.00");
    expect(amountText("1234567890000000000000000", 18)).toBe("1,234,567");
    expect(cleanName(`  Vault\u0000 0x${"ab".repeat(20)}\n‮Name  `)).toBe("Vault Name");
    expect([...cleanName("x".repeat(80))].length).toBe(50);
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  test("armed positions and presets come from the DB, active and confirmed only", async () => {
    db = await freshDb();
    expect(await armedOn(db, V)).toEqual({ positions: 0, presets: [] });
    await arm(1, [KEY("Vault loss"), KEY("Exploit confirmed")]);
    await arm(2, [KEY("Vault loss")]);
    await arm(3, [KEY("Paused")], { active: false });
    await arm(4, [KEY("Paused")], { confirmed: false });
    expect(await armedOn(db, V)).toEqual({ positions: 2, presets: ["Vault loss", "Exploit confirmed"] });
  });
});

describe("the card image", () => {
  const facts = factsFrom(LAUNCH_CARD, { positions: 3, presets: ["Vault loss", "Exploit confirmed"] });

  test("the SVG is 1200 by 675, carries the site and the logo, and holds no wallet address", () => {
    const svg = renderSvg(facts);
    expect(svg).toContain('width="1200" height="675"');
    expect(svg).toContain("canopyrh.com");
    expect(svg).toContain(XRAY.pitch);
    expect(svg).toContain("data:image/png;base64,");
    expect(bare(svg)).not.toMatch(/0x[0-9a-f]{6,}/i);
    expect(bare(svg)).toContain("Steakhouse USDG");
  });

  test("markup in a vault name is escaped", () => {
    const svg = renderSvg(factsFrom(GATED_CARD, NONE));
    expect(bare(svg)).toContain("&lt;b&gt;Strategy&lt;/b&gt; &amp; Vault");
    expect(bare(svg)).not.toContain("<b>");
  });

  test("the PNG is valid and 1200 by 675", async () => {
    const png = await renderPng(renderSvg(facts));
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(675);
    expect(new TextDecoder().decode(png.slice(-8, -4))).toBe("IEND");
    expect(png.length).toBeGreaterThan(10_000);
  });

  test("the wording passes the banned-words gate", () => {
    const text = [XRAY.pitch, XRAY.footnote, ...changeLines(facts), ...armedLines(facts), summary(facts), ...changeLines(factsFrom(GATED_CARD, NONE))].join("\n");
    expect(findBanned(text)).toEqual([]);
  });
});

describe("GET /xray/:vault", () => {
  const get = (app: ReturnType<typeof api>, path: string, ip = "9.9.9.9") => app.request(path, { headers: { "x-forwarded-for": ip } });

  test("serves png, svg and json for a vault with a saved card, and the share page for the bare address", async () => {
    db = await freshDb();
    await repo(db).saveCard(V, LAUNCH_CARD, "text", 1);
    await arm(1, [KEY("Vault loss")]);
    const app = api();
    const png = await get(app, `/xray/${V}.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("cache-control")).toBe(`public, max-age=${XRAY_TTL}`);
    expect(new Uint8Array(await png.arrayBuffer()).slice(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));
    const svg = await get(app, `/xray/${V}.svg`);
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    const drawn = bare(await svg.text());
    expect(drawn).toContain(">1</text>");
    expect(drawn).toContain(">position armed</text>");
    const json = (await (await get(app, `/xray/${V}.json`)).json()) as Record<string, unknown>;
    expect(json).toMatchObject({ armed: 1, presets: ["Vault loss"], image: `https://api.example.test/xray/${V}.png`, share: `https://api.example.test/xray/${V}` });
    expect(JSON.stringify(json)).not.toContain(LAUNCH_CARD.owner!);
    expect(JSON.stringify(json)).not.toContain(LAUNCH_CARD.curator!);
    const mixed = await get(app, `/xray/${LAUNCH_VAULT}.json`); // a checksummed address finds the same card
    expect(mixed.status).toBe(200);
  });

  test("a bad address is 400 and a vault with no card is 404", async () => {
    const app = api();
    expect((await get(app, "/xray/nope.png")).status).toBe(400);
    expect((await get(app, "/xray/0x123.png")).status).toBe(400);
    expect((await get(app, `/xray/${V.slice(0, -1)}g.png`)).status).toBe(400);
    expect((await get(app, "/xray/0x00000000000000000000000000000000000000f9.png")).status).toBe(404);
  });

  test("a card is reused for five minutes, then drawn again from fresh numbers", async () => {
    db = await freshDb();
    await repo(db).saveCard(V, LAUNCH_CARD, "text", 1);
    const app = api();
    const read = async () => ((await (await get(app, `/xray/${V}.json`)).json()) as { armed: number }).armed;
    clock = { t: 20_000 };
    expect(await read()).toBe(0);
    await arm(1, [KEY("Vault loss")]);
    clock.t += XRAY_TTL - 1;
    expect(await read()).toBe(0);
    const first = new Uint8Array(await (await get(app, `/xray/${V}.png`)).arrayBuffer());
    expect(new Uint8Array(await (await get(app, `/xray/${V}.png`)).arrayBuffer())).toEqual(first);
    clock.t += 2;
    expect(await read()).toBe(1);
  });

  test("it shares the read limit with the other routes", async () => {
    db = await freshDb();
    await repo(db).saveCard(V, LAUNCH_CARD, "text", 1);
    const app = api({ perMin: 2 });
    clock = { t: 30_000 };
    expect([(await get(app, `/xray/${V}.png`, "4.4.4.4")).status, (await get(app, `/xray/${V}.png`, "4.4.4.4")).status, (await get(app, `/xray/${V}.png`, "4.4.4.4")).status]).toEqual([200, 200, 429]);
    expect((await get(app, `/xray/${V}.png`, "5.5.5.5")).status).toBe(200);
  });
});

describe("link previews", () => {
  const facts = factsFrom(LAUNCH_CARD, { positions: 3, presets: [] });
  const html = sharePage(facts, { pageUrl: `https://api.example.test/xray/${V}`, imageUrl: `https://api.example.test/xray/${V}.png`, siteUrl: "https://canopyrh.com" });
  const meta = (k: string) => new RegExp(`<meta (?:property|name)="${k}" content="([^"]*)">`).exec(html)?.[1];

  test("the share page names the card image in Open Graph and Twitter tags", () => {
    expect(meta("og:image")).toBe(`https://api.example.test/xray/${V}.png`);
    expect(meta("twitter:image")).toBe(`https://api.example.test/xray/${V}.png`);
    expect(meta("twitter:card")).toBe("summary_large_image");
    expect(meta("og:image:width")).toBe("1200");
    expect(meta("og:image:height")).toBe("675");
    expect(meta("og:title")).toContain("Steakhouse USDG");
    expect(meta("og:description")).toContain(XRAY.pitch);
    expect(html).toContain(`<link rel="canonical" href="https://canopyrh.com/xray.html?vault=${V}">`);
    expect(html).toContain("canopyrh.com");
  });

  test("a hostile vault name can't break out of an attribute", () => {
    const evil = sharePage({ ...facts, name: `"><script>alert(1)</script>` }, { pageUrl: "https://a.test/x", imageUrl: "https://a.test/x.png", siteUrl: "https://canopyrh.com" });
    expect(evil).not.toContain("<script>");
  });

  test("the share route serves that page", async () => {
    db = await freshDb();
    await repo(db).saveCard(V, LAUNCH_CARD, "text", 1);
    clock = { t: 40_000 };
    const res = await api().request(`/xray/${V}`);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain(`<meta property="og:image" content="https://api.example.test/xray/${V}.png">`);
  });
});
