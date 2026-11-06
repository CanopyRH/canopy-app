// Audit 2 PoC A2-L3: both watchers sign a listed vault's "Exploit confirmed" alarm with no exploit on that vault.
//
// The on-chain half: anyone with capital parks a deposit in the vault for over half an hour, then withdraws it. The
// scan's DRAIN signal is measured against the hour's median, which the parked deposit set, so the withdrawal reads as a
// 37% drain. The report half: any report the classifier labels about "Morpho" (for example a depeg in some other Morpho
// market) matches every vault, because every launch vault runs on Morpho. decide() sees one on-chain soft signal plus
// one feed signal and attests. Real code throughout: scanVault, matchVaults, feedSignal, maybeAttest, acceptAttestation.
// Run: bun test test/audit2-false-quorum.test.ts
import { expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { presetsFor } from "../src/api/presets";
import { feedSignal, type Signal } from "../src/detectors";
import { scanVault } from "../src/detectors/scan";
import { repo } from "../src/store/repo";
import { acceptAttestation, matchVaults, maybeAttest } from "../src/watcher/watcher";
import { quorumScope } from "../src/watcher/scope";
import { freshDb } from "./db";

const BOOK = "0x00000000000000000000000000000000000000aa" as Address;
const VAULT = "0x00000000000000000000000000000000000000c9" as Address; // a listed vault
const wA = privateKeyToAccount(`0x${"a1".padStart(64, "0")}`);
const wB = privateKeyToAccount(`0x${"b2".padStart(64, "0")}`);

test("a parked-then-withdrawn deposit plus an unrelated Morpho report gets the listed vault's exploit alarm signed", async () => {
  const db = await freshDb();
  const r = repo(db);
  const v = VAULT.toLowerCase();
  const quorum = presetsFor(VAULT).find((p) => p.detector.kind === 5)!;
  await db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,5,$2,2,0,'0x','0x')`, [quorum.key, v]);
  await r.saveCard(v, { name: "Steakhouse USDG" }, "card", 0);

  // The vault holds 10M. The depositor adds 6M at minute 0 and takes it out at minute 36. Nothing else happens.
  let totalAssets = 16_000_000n * 10n ** 6n;
  const client = {
    getCode: async () => "0x6001",
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "totalAssets") return totalAssets;
      if (functionName === "convertToAssets") return 10n ** 18n; // share price never moves
      throw new Error("no such read");
    },
  };
  let now = 1_000_000;
  for (let minute = 0; minute <= 36; minute++) {
    if (minute === 36) totalAssets = 10_000_000n * 10n ** 6n;
    await scanVault({ client: client as never, repo: r, now: () => now }, v as Address);
    now += 60;
  }
  now -= 60;
  const soft = (await r.recentSignals(v, now - 3600)) as Signal[];
  expect(soft.map((s) => s.kind)).toEqual(["DRAIN"]);

  // A labelled report about a different Morpho market. The vault name doesn't appear in it.
  const report = { label: "DEPEG_REPORT" as const, protocol: "Morpho", confidence: 0.85 };
  const keys = await db.query<{ key: Hex; target: Hex; name: string }>(
    `SELECT d.key, d.target, COALESCE(c.numbers->>'name', '') AS name FROM detectors d LEFT JOIN risk_cards c ON c.target=d.target WHERE d.kind=5`);
  const inScope = quorumScope(r, [v], () => now, true);
  const scoped = [];
  for (const k of keys) if (await inScope(k.key, k.target)) scoped.push(k);
  const matched = matchVaults(report.protocol, scoped);
  expect(matched.map((m) => m.key)).toEqual([quorum.key]);

  // Both watchers run the same rules and sign the same values.
  for (const w of [wA, wB]) {
    const feed = feedSignal(report, v as Hex, now, "report-hash")!;
    const a = await maybeAttest(w, BOOK, 4663, quorum.key, [...soft, feed], now);
    expect(a).not.toBeNull();
    expect(await acceptAttestation(db, [wA.address, wB.address], BOOK, 4663, a!, now)).toBe(true);
  }
  const ready = await r.quorumReady(2, now);
  console.log(`A2-L3: drain signal ${soft[0]!.value / 100}% from a parked deposit; quorum ready for the listed vault's preset: ${ready.length === 1}`);
  expect(ready.map((q) => q.key)).toEqual([quorum.key]);
});
