// Real code throughout: scanVault, matchVaults, feedSignal, maybeAttest, acceptAttestation.
import { beforeEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { presetsFor } from "../src/api/presets";
import { feedSignal, type Signal } from "../src/detectors";
import { scanVault } from "../src/detectors/scan";
import type { Classification } from "../src/engine/llmClassify";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { acceptAttestation, matchVaults, maybeAttest } from "../src/watcher/watcher";
import { quorumScope } from "../src/watcher/scope";
import { freshDb } from "./db";

const BOOK = "0x00000000000000000000000000000000000000aa" as Address;
const VAULT = "0x00000000000000000000000000000000000000c9" as Address; // a listed vault
const CURATOR = "0x00000000000000000000000000000000000000c1";
const wA = privateKeyToAccount(`0x${"a1".padStart(64, "0")}`);
const wB = privateKeyToAccount(`0x${"b2".padStart(64, "0")}`);
const M = 10n ** 6n * 1_000_000n; // one million units of a 6-decimal asset
const v = VAULT.toLowerCase();
const quorum = presetsFor(VAULT).find((p) => p.detector.kind === 5)!;

let db: Db;
let r: Repo;
let now: number;
let totalAssets: bigint;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
  await db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,5,$2,2,0,'0x','0x')`, [quorum.key, v]);
  await r.saveCard(v, { name: "Steakhouse USDG", curator: CURATOR, assetSymbol: "USDG" }, "card", 0);
  now = 1_000_000;
  totalAssets = 10n * M;
});

const client = {
  getCode: async () => "0x6001",
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "totalAssets") return totalAssets;
    if (functionName === "convertToAssets") return 10n ** 18n; // share price never moves
    throw new Error("no such read");
  },
};

/** One scan a minute for `minutes`, with `at(minute)` setting the vault's assets before each. */
async function scan(minutes: number, at: (minute: number) => bigint = () => totalAssets) {
  for (let m = 0; m < minutes; m++) {
    totalAssets = at(m);
    await scanVault({ client: client as never, repo: r, now: () => now }, VAULT);
    now += 60;
  }
  now -= 60;
}

/** Runs a report through both watchers the way the feed loop does, and returns whether the alarm is ready to fire. */
async function bothWatchers(report: Classification, approved = false) {
  const keys = await db.query<{ key: Hex; target: Hex; name: string; curator: string; asset: string }>(
    `SELECT d.key, d.target, COALESCE(c.numbers->>'name', '') AS name, COALESCE(c.numbers->>'curator', '') AS curator, COALESCE(c.numbers->>'assetSymbol', '') AS asset
     FROM detectors d LEFT JOIN risk_cards c ON c.target=d.target WHERE d.kind=5`);
  const inScope = quorumScope(r, [v], () => now, true);
  const scoped = [];
  for (const k of keys) if (await inScope(k.key, k.target)) scoped.push(k);
  const soft = (await r.recentSignals(v, now - 3600)) as Signal[];
  for (const { key, target } of matchVaults(report.protocol, scoped, report.label, approved ? {chainId:4663,hash:"a".repeat(64),sourceUrl:"https://reports.example/item",now,approvals:{version:1,reports:[{chainId:4663,sha256:"a".repeat(64),sourceUrl:"https://reports.example/item",targets:[v],reviewedAt:now-1,expiresAt:now+100}]}} : undefined)) {
    for (const w of [wA, wB]) {
      const feed = feedSignal(report, target, now, "report-hash")!;
      const a = await maybeAttest(w, BOOK, 4663, key, [...soft, feed], now);
      if (a) await acceptAttestation(db, [wA.address, wB.address], BOOK, 4663, a, now);
    }
  }
  return (await r.quorumReady(2, now)).map((q) => q.key);
}

describe("a staged exploit confirmation", () => {
  test("a parked-then-withdrawn deposit plus a report naming only Morpho gets nothing signed", async () => {
    await scan(180); // three hours at 10M
    // The depositor adds 6M and takes it out 36 minutes later. Nothing else happens.
    await scan(37, (m) => (m < 36 ? 16n * M : 10n * M));
    // Before: a 37.5% DRAIN signal, a match on every vault, and both watchers' signatures.
    expect((await r.recentSignals(v, now - 3600)).map((s) => s.kind)).toEqual([]);
    expect(await bothWatchers({ label: "DEPEG_REPORT", protocol: "Morpho", confidence: 0.85 })).toEqual([]);
  });

  test("each half alone is now refused: a Morpho-only report matches no vault even with a real drain signal", async () => {
    await scan(180);
    await scan(2, (m) => (m === 0 ? 10n * M : 5n * M));
    expect((await r.recentSignals(v, now - 3600)).map((s) => s.kind)).toEqual(["DRAIN"]);
    expect(await bothWatchers({ label: "EXPLOIT_CONFIRMED", protocol: "Morpho Blue", confidence: 0.9 })).toEqual([]);
  });

  test("a real drain with reviewed report attribution is still signed by both watchers", async () => {
    await scan(180);
    await scan(2, (m) => (m === 0 ? 10n * M : 5n * M));
    expect(await bothWatchers({ label: "EXPLOIT_CONFIRMED", protocol: "Steakhouse", confidence: 0.9 }, true)).toEqual([quorum.key]);
  });

  test("curator addresses and depeg asset names cannot authorize exploit signatures", async () => {
    const vaults = [{ name: "Steakhouse USDG", target: v, curator: CURATOR, asset: "USDG" }, { name: "Gauntlet USDC", target: "0x" + "d".repeat(40), curator: "", asset: "USDC" }];
    expect(matchVaults(`curator ${CURATOR}`, vaults, "EXPLOIT_CONFIRMED").map((x) => x.name)).toEqual([]);
    expect(matchVaults("USDG", vaults, "DEPEG_REPORT").map((x) => x.name)).toEqual([]);
    expect(matchVaults("USDG", vaults, "EXPLOIT_CONFIRMED")).toEqual([]);
    expect(matchVaults("Morpho", vaults, "DEPEG_REPORT")).toEqual([]);
  });

  test("capital parked for hours still reads as a return to the usual level when it leaves", async () => {
    await scan(24 * 60); // a day at 10M
    await scan(5 * 60 + 1, (m) => (m < 5 * 60 ? 16n * M : 10n * M)); // parked five hours, then withdrawn
    expect((await r.recentSignals(v, now - 3600)).map((s) => s.kind)).toEqual([]);
  }, 60_000);
});
