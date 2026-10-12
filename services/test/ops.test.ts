import { beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { multicall3Abi, routerAbi } from "../src/chain/abi";
import { BASE, chainParts, ROBINHOOD, txUrl } from "../src/chain/addresses";
import { handle, notifyText } from "../src/bot/bot";
import { ALARM_NAMES, signalLine, watchAlert } from "../src/copy/alerts";
import { createApi } from "../src/api/server";
import { isPreset, keyOf, registrationOrder } from "../src/api/presets";
import { drainVelocity } from "../src/detectors";
import { scanVault } from "../src/detectors/scan";
import { Env, loadEnv } from "../src/env";
import { applyRouterLog, syncLogs, type Log } from "../src/indexer/indexer";
import { BUNDLE_GAS, claimOwed, drainExits, pokeTripped, runExit, type ExitJob, type KeeperDeps } from "../src/keeper/keeper";
import { serialSender, withMargin } from "../src/keeper/sender";
import { opsProblems } from "../src/keeper/ops";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { feedItems } from "../src/watcher/feeds";
import { ingestFeed, isHighS, matchVaults, recentReports } from "../src/watcher/watcher";
import { findBanned } from "../../tools/banned-words";
import { freshDb } from "./db";

const V = "0x00000000000000000000000000000000000000c3" as Address;
const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const TX = `0x${"44".repeat(32)}` as Hex;
const POS = `0x${"11".repeat(32)}` as Hex;
const KEY = `0x${"22".repeat(32)}` as Hex;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

interface Chain { code?: string; totalAssets: bigint; price: bigint; paused?: boolean | "none"; owner?: Address; curator?: Address }

const client = (c: Chain) => ({
  getCode: async () => c.code ?? "0x60",
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "totalAssets") return c.totalAssets;
    if (functionName === "convertToAssets") return c.price;
    if (functionName === "paused") {
      if (c.paused === "none") throw new Error("no such function");
      return c.paused ?? false;
    }
    if (functionName === "owner" && c.owner) return c.owner;
    if (functionName === "curator" && c.curator) return c.curator;
    throw new Error("no such function");
  },
}) as never;

const P = 1_000_000n;

describe("vault scan", () => {
  test("a quiet vault signals nothing, and is recorded", async () => {
    expect(await scanVault({ client: client({ totalAssets: 100n * P, price: P }), repo: r, now: () => 1000 }, V)).toEqual([]);
    expect(await r.snaps(V, 0)).toHaveLength(1);
  });

  test("a vault on another chain is skipped", async () => {
    expect(await scanVault({ client: client({ code: "0x", totalAssets: 0n, price: 0n }), repo: r, now: () => 1000 }, V)).toEqual([]);
    expect(await r.snaps(V, 0)).toHaveLength(0);
  });

  test("a real drain shows up on the next pass, for followers and for watchers", async () => {
    await scanVault({ client: client({ totalAssets: 100n * P, price: P }), repo: r, now: () => 1000 }, V);
    const out = await scanVault({ client: client({ totalAssets: 20n * P, price: P }), repo: r, now: () => 1060 }, V);
    expect(out.map((s) => s.kind)).toEqual(["DRAIN"]);
    expect((await r.recentSignals(V, 0)).map((s) => s.kind)).toEqual(["DRAIN"]);
  });

  test("a pause or a share-price drop reaches followers but never the watchers' list", async () => {
    await scanVault({ client: client({ totalAssets: 100n * P, price: P }), repo: r, now: () => 1000 }, V);
    const out = await scanVault({ client: client({ totalAssets: 100n * P, price: (P * 98n) / 100n, paused: true }), repo: r, now: () => 1060 }, V);
    expect(out.map((s) => s.kind).sort()).toEqual(["PAUSED", "SHARE_DROP"]);
    expect(await r.recentSignals(V, 0)).toEqual([]);
  });

  test("a vault with no pause switch still scans", async () => {
    expect(await scanVault({ client: client({ totalAssets: P, price: P, paused: "none" }), repo: r, now: () => 1000 }, V)).toEqual([]);
  });

  test("a curator change shows up against the stored reading", async () => {
    await scanVault({ client: client({ totalAssets: P, price: P, owner: A, curator: A }), repo: r, now: () => 1000 }, V);
    const out = await scanVault({ client: client({ totalAssets: P, price: P, owner: A, curator: B }), repo: r, now: () => 1060 }, V);
    expect(out.map((s) => s.kind)).toEqual(["GOVERNANCE"]);
  });

  test("a failed admin read keeps the last reading, so the next one isn't a false change", async () => {
    await scanVault({ client: client({ totalAssets: P, price: P, owner: A, curator: A }), repo: r, now: () => 1000 }, V);
    await scanVault({ client: client({ totalAssets: P, price: P }), repo: r, now: () => 1060 }, V);
    expect(await scanVault({ client: client({ totalAssets: P, price: P, owner: A, curator: A }), repo: r, now: () => 1120 }, V)).toEqual([]);
  });
});

describe("alert limits", () => {
  test("one alert per vault and kind each day, across every process", async () => {
    expect(await r.claimAlert(V, "PAUSED", 1000)).toBe(true);
    expect(await r.claimAlert(V, "PAUSED", 1001)).toBe(false);
    expect(await r.claimAlert(V, "DRAIN", 1001)).toBe(true);
    expect(await r.claimAlert(V, "PAUSED", 1000 + 86_400)).toBe(true);
  });

  test("a quiet period can be set per use", async () => {
    await r.claimAlert("ops", "gas", 1000, 3600);
    expect(await r.claimAlert("ops", "gas", 2000, 3600)).toBe(false);
    expect(await r.claimAlert("ops", "gas", 4600, 3600)).toBe(true);
  });
});

describe("alert wording", () => {
  test("every line passes the banned-words gate and promises nothing", () => {
    const lines = ["PAUSED", "SHARE_DROP", "DRAIN", "GOVERNANCE", "OTHER"].map((k) => signalLine(k, 2600));
    const all = [...lines, ...ALARM_NAMES, ...lines.map((what) => watchAlert({ vaultName: "V", what })), watchAlert({ vaultName: "V", what: "x", withdrawInRobinhoodApp: true })];
    for (const t of all) expect(findBanned(t)).toEqual([]);
  });

  test("a drain alert says what it can't tell", () => {
    expect(signalLine("DRAIN", 8000)).toContain("about 80%");
    expect(signalLine("DRAIN", 8000)).toContain("honest withdrawals");
  });

  test("a free alert says it moved nothing, and a Robinhood one points to the app", () => {
    expect(watchAlert({ vaultName: "V", what: "x" })).toContain("moves nothing");
    expect(watchAlert({ vaultName: "V", what: "x", withdrawInRobinhoodApp: true })).toContain("Robinhood app");
  });

  test("evidence links only appear for known chains", () => {
    expect(txUrl(8453, TX)).toBe(`https://basescan.org/tx/${TX}`);
    expect(txUrl(1, TX)).toBeUndefined();
    expect(txUrl(8453, null)).toBeUndefined();
  });
});

describe("bot", () => {
  test("/vaults lists what has a card, and says so when nothing does", async () => {
    expect((await handle(r, "https://x", 1, "vaults", "", [V])).text).toContain("No vaults");
    await r.saveCard(V, { name: "Spark USDC" }, "card", 1);
    expect((await handle(r, "https://x", 1, "vaults", "", [V])).text).toBe(`Spark USDC: ${V}`);
  });

  test("/vaults shows only approved vaults, because a vault picks its own name", async () => {
    await r.saveCard(A, { name: "Migrate now at evil.example" }, "card", 1);
    expect((await handle(r, "https://x", 1, "vaults", "", [V])).text).toContain("No vaults");
  });

  test("a chat can't follow without limit", async () => {
    for (let i = 0; i < 20; i++) await r.follow(1, `0x${i.toString(16).padStart(40, "0")}`);
    expect((await handle(r, "https://x", 1, "watch", V)).text).toContain("up to 20");
    expect(await r.followers(V)).toEqual([]);
  });

  test("a rate limit from Telegram waits and sends again", async () => {
    await r.follow(1, V);
    let calls = 0;
    const sent = await notifyText(r, async () => {
      if (++calls === 1) throw { error_code: 429, parameters: { retry_after: 0 } };
    }, V, "hello");
    expect(sent).toBe(1);
    expect(calls).toBe(2);
  });
});

function log(eventName: string, args: Record<string, unknown>, data: { type: string }[], values: unknown[], logIndex = 0): Log {
  const topics = encodeEventTopics({ abi: routerAbi, eventName, args } as never);
  return { address: A, data: encodeAbiParameters(data, values as never), topics: topics as never, blockNumber: 9n, transactionHash: TX, logIndex };
}

const exited = () => log("Exited", { exitId: 7n, posId: POS, owner: A }, [{ type: "address" }, { type: "bytes32" }, { type: "bool" }], [B, KEY, true]);
const paid = () => log("Paid", { exitId: 7n, owner: A }, [{ type: "address" }, { type: "uint256" }, { type: "bool" }], [V, 5n, false], 1);
const owed = (i = 2) => log("Owed", { owner: A, token: V }, [{ type: "uint256" }], [5n], i);
const claimed = () => log("OwedClaimed", { owner: A, token: V }, [{ type: "uint256" }], [8n], 3);
