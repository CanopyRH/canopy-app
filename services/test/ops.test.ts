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

describe("exit records", () => {
  test("an exit and its payout are stored once, however often the logs replay", async () => {
    for (let i = 0; i < 2; i++) {
      await applyRouterLog(r, exited());
      await applyRouterLog(r, paid());
    }
    const rows = await db.query<{ owner: string; via_alarm: boolean }>(`SELECT owner, via_alarm FROM exits`);
    expect(rows).toEqual([{ owner: A, via_alarm: true }]);
    expect(await db.query(`SELECT 1 FROM exit_payouts`)).toHaveLength(1);
  });

  test("owed amounts add up, a replay doesn't double them, and a claim clears them", async () => {
    await applyRouterLog(r, owed(2));
    await applyRouterLog(r, owed(2));
    await applyRouterLog(r, owed(4));
    expect((await r.openOwed()).map((o) => Number(o.amount))).toEqual([10]);
    await applyRouterLog(r, claimed());
    expect(await r.openOwed()).toEqual([]);
  });
});

describe("owed claims", () => {
  const deps = (works: (owner: string) => boolean, sent: unknown[]) =>
    ({
      repo: r,
      router: A,
      account: B,
      send: async (tx: unknown) => void sent.push(tx),
      client: { simulateContract: async ({ args }: { args: string[] }) => { if (!works(args[0]!)) throw new Error("paused"); } },
    }) as unknown as KeeperDeps;

  test("only what the chain would pay gets sent, and a stuck token never blocks the rest", async () => {
    await r.addOwed(TX, 1, A, V, 5n);
    await r.addOwed(TX, 2, B, V, 5n);
    const sent: unknown[] = [];
    await claimOwed(deps((o) => o === B, sent));
    expect(sent).toHaveLength(1);
  });
});

describe("quorum across hosts", () => {
  const add = (signer: Address, deadline: number) => db.query(`INSERT INTO attestations (key, evidence_hash, deadline, signer, sig) VALUES ($1,$2,$3,$4,$5)`, [KEY, TX, deadline, signer, "0x"]);

  test("a set with enough signers is ready for whichever process holds the keeper key", async () => {
    await add(A, 2000);
    expect(await r.quorumReady(2, 1000)).toEqual([]);
    await add(B, 2000);
    expect((await r.quorumReady(2, 1000)).map((q) => q.key)).toEqual([KEY]);
  });

  test("an expired set is not ready", async () => {
    await add(A, 2000);
    await add(B, 2000);
    expect(await r.quorumReady(2, 2000)).toEqual([]);
  });

  test("a signer can sign the same evidence for a new deadline, so two watchers either side of a window still meet", async () => {
    await add(A, 2000);
    await add(A, 2600);
    await add(B, 2600);
    expect((await r.quorumReady(2, 1000)).map((q) => Number(q.deadline))).toEqual([2600]);
  });
});

describe("chain parts", () => {
  test("the keeper uses the Morpho and the lag limit of its own chain", () => {
    expect(chainParts(4663).morpho).toBe(ROBINHOOD.morpho);
    expect(chainParts(8453).morpho).toBe(BASE.morpho);
    expect(chainParts(4663).maxLagBlocks).toBe(400n);
    expect(chainParts(8453).maxLagBlocks).toBe(20n);
    expect(txUrl(4663, "0xabc")).toBe("https://robinhoodchain.blockscout.com/tx/0xabc");
  });
});

describe("operator checks", () => {
  const fine = { lagBlocks: 0n, gasWei: 10n, minGasWei: 1n, oldestJobSec: 0 };

  test("a healthy system says nothing", () => {
    expect(opsProblems(fine)).toEqual([]);
  });

  test("lag above 20 blocks, low gas and a stuck job each raise their own warning", () => {
    expect(opsProblems({ ...fine, lagBlocks: 20n })).toEqual([]);
    // Robinhood Chain makes about 10 blocks a second, so 20 blocks is only 2 seconds there.
    expect(opsProblems({ ...fine, lagBlocks: 399n, maxLagBlocks: 400n })).toEqual([]);
    expect(opsProblems({ ...fine, lagBlocks: 401n, maxLagBlocks: 400n }).map((p) => p.code)).toEqual(["lag"]);
    expect(opsProblems({ ...fine, lagBlocks: 21n }).map((p) => p.code)).toEqual(["lag"]);
    expect(opsProblems({ ...fine, gasWei: 0n }).map((p) => p.code)).toEqual(["gas"]);
    expect(opsProblems({ ...fine, oldestJobSec: 301 }).map((p) => p.code)).toEqual(["jobs"]);
  });

  test("health numbers never name a wallet", async () => {
    await r.enqueue("exit", "d", {}, 900);
    await r.bump("poke_ok");
    await r.bump("poke_ok");
    await r.setCursor("router", 5n);
    await applyRouterLog(r, exited());
    const h = await r.health(1000);
    expect(h).toEqual({ openJobs: 1, oldestJobSec: 100, alarmExits: 1, watchersSeen7d: 0, counters: { poke_ok: "2" }, cursors: { router: "5" } });
    expect(JSON.stringify(h)).not.toContain(A.slice(2));
  });
});

describe("settings", () => {
  const base = { PUBLIC_URL: "https://x.example", DATABASE_URL: "postgres://x", CHAIN_ID: "4663", RPC_URL: "https://a.example", RPC_URL_BACKUP: "https://b.example", TELEGRAM_BOT_TOKEN: "1:a", TELEGRAM_WEBHOOK_SECRET: "s".repeat(16) };

  test("an alerts-only chain needs no contracts", () => {
    expect(Env.safeParse({ ...base, ALERTS_ONLY: "true" }).success).toBe(true);
  });

  test("blank lines in an env file count as not set", () => {
    const e = loadEnv({ ...base, ALERTS_ONLY: "true", ROUTER: "", OPS_CHAT_ID: "" });
    expect(e.ROUTER).toBeUndefined();
    expect(e.OPS_CHAT_ID).toBeUndefined();
  });

  test("a normal deployment can't start with a contract missing", () => {
    const r = Env.safeParse(base);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path[0])).toEqual(["ROUTER", "ALARM_BOOK", "ADAPTER_4626", "PLAN_PAY_ADDRESS", "PLAN_TOKEN"]);
  });
});

describe("keeper sending", () => {
  const TX1 = `0x${"01".repeat(32)}` as Hex;
  const CALL = { to: V, data: "0x" as Hex };

  function chain(opts: { landAfter?: number; failFirstSend?: boolean } = {}) {
    let clock = 0;
    const sends: { nonce: number; fee: bigint }[] = [];
    const d = {
      pendingNonce: async () => 5 + sends.filter((s) => s.nonce !== 5).length,
      fees: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
      send: async (_: unknown, nonce: number, f: { maxFeePerGas: bigint }) => {
        if (opts.failFirstSend && sends.length === 0) {
          sends.push({ nonce, fee: f.maxFeePerGas });
          throw new Error("rejected");
        }
        sends.push({ nonce, fee: f.maxFeePerGas });
        return TX1;
      },
      receipt: async () => (sends.length >= (opts.landAfter ?? 1) ? { status: "success" } : null),
      sleep: async (ms: number) => void (clock += ms),
      now: () => clock,
    };
    return { d, sends };
  }

  test("a stuck transaction is replaced on the same nonce at a higher fee", async () => {
    const { d, sends } = chain({ landAfter: 3 });
    await serialSender(d)(CALL);
    expect(sends).toEqual([{ nonce: 5, fee: 100n }, { nonce: 5, fee: 125n }, { nonce: 5, fee: 156n }]);
  });

  test("it gives up with a clear error, instead of waiting forever", async () => {
    const { d, sends } = chain({ landAfter: 99 });
    await expect(serialSender(d)(CALL)).rejects.toThrow("stuck at nonce 5");
    expect(sends).toHaveLength(4);
  });

  test("a call that can't be sent fails at once", async () => {
    const { d } = chain({ failFirstSend: true });
    await expect(serialSender(d)(CALL)).rejects.toThrow("rejected");
  });

  test("a reverted transaction is an error", async () => {
    const { d } = chain();
    d.receipt = async () => ({ status: "reverted" });
    await expect(serialSender(d)(CALL)).rejects.toThrow("reverted");
  });
});
