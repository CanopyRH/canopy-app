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
import { applyRouterLog, type Log } from "../src/indexer/indexer";
import { BUNDLE_GAS, CHECK_CALL_GAS, CHECKS_PER_CALL, claimOwed, EXIT_SWAP_HEADROOM, drainExits, pokeTripped, runExit, type ExitJob, type KeeperDeps } from "../src/keeper/keeper";
import { serialSender, withMargin } from "../src/keeper/sender";
import { opsProblems } from "../src/keeper/ops";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { feedItems } from "../src/watcher/feeds";
import { ingestFeed, isHighS, matchVaults, recentReports } from "../src/watcher/watcher";
import { findBanned } from "../../tools/banned-words";
import { checkNode, type CheckRequest } from "./check-node";
import { freshDb } from "./db";
import { enqueueExit } from "./jobs";

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
    expect(h).toEqual({ retryingLogs: 0, oldestRetryingLogSec: 0, openJobs: 1, oldestJobSec: 100, alarmExits: 1, watchersSeen7d: 0, counters: { poke_ok: "2" }, cursors: { router: "5" } });
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
    expect(r.error?.issues.map((i) => i.path[0]).sort()).toEqual(["ROUTER", "ALARM_BOOK", "ADAPTER_4626", "PLAN_PAY_ADDRESS", "PLAN_TOKEN"].sort());
  });

  const contracts = { ROUTER: V, ALARM_BOOK: V, ADAPTER_4626: V };
  const independent = { DATABASE_URL: "postgres://x", CHAIN_ID: "4663", RPC_URL: "https://a.example", RPC_URL_BACKUP: "https://b.example", ...contracts };

  test("an independent keeper runs with no Telegram, no public URL and no plan settings", () => {
    const e = loadEnv({ ...independent, ROLE: "indexer, keeper", KEEPER_PAID_ONLY: "false" });
    expect(e.ROLE).toEqual(["indexer", "keeper"]);
    expect(e.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(e.PLAN_TOKEN).toBeUndefined();
  });

  test("a keeper serving paid wallets still needs the plan settings", () => {
    const r = Env.safeParse({ ...independent, ROLE: "indexer,keeper" });
    expect(r.error?.issues.map((i) => i.path[0])).toEqual(["PLAN_PAY_ADDRESS", "PLAN_TOKEN"]);
  });

  test("the api and bot roles still need Telegram and a public URL", () => {
    for (const ROLE of ["api", "bot", "all", "keeper,api"]) {
      const r = Env.safeParse({ ...independent, ROLE, KEEPER_PAID_ONLY: "false" });
      expect(r.error?.issues.map((i) => i.path[0])).toEqual(["PUBLIC_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]);
    }
  });

  test("a bot token needs somewhere for its Open Canopy button to point", () => {
    const r = Env.safeParse({ ...independent, ROLE: "detector", KEEPER_PAID_ONLY: "false", TELEGRAM_BOT_TOKEN: "1:a" });
    expect(r.error?.issues.map((i) => i.path[0])).toEqual(["APP_URL"]);
    expect(Env.safeParse({ ...independent, ROLE: "detector", KEEPER_PAID_ONLY: "false", TELEGRAM_BOT_TOKEN: "1:a", APP_URL: "https://app.example" }).success).toBe(true);
  });

  test("an unknown or empty role is refused", () => {
    expect(Env.safeParse({ ...base, ALERTS_ONLY: "true", ROLE: "keeper,miner" }).success).toBe(false);
    expect(Env.safeParse({ ...base, ALERTS_ONLY: "true", ROLE: " , " }).success).toBe(false);
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

  test("two loops never send at the same time, and a failure doesn't stop the next", async () => {
    let running = 0;
    let most = 0;
    const { d } = chain();
    const inner = d.send;
    d.send = async (...a: Parameters<typeof inner>) => {
      running++;
      most = Math.max(most, running);
      await Bun.sleep(1);
      running--;
      return inner(...a);
    };
    const send = serialSender(d);
    d.fees = async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    const out = await Promise.allSettled([send(CALL), send(CALL), send(CALL)]);
    expect(most).toBe(1);
    expect(out.every((o) => o.status === "fulfilled")).toBe(true);
  });
});

describe("keeper resilience", () => {
  const job = { posId: POS, key: KEY, owner: A, target: V, firedAt: 1000 };
  const OK = "0x0000000000000000000000000000000000000000000000000000000000000001";
  const ZERO_WORD = `0x${"00".repeat(32)}`;

  function exitDeps(after: { shares: bigint; allowance: bigint }) {
    let sent = 0;
    const read = ({ functionName }: { functionName: string }) => {
      if (functionName === "asset") return stableToken;
      if (functionName === "liquidityAdapter") throw new Error("not v2");
      if (functionName === "balanceOf") return sent ? after.shares : 100n;
      if (functionName === "allowance") return sent ? after.allowance : 100n;
      throw new Error(functionName);
    };
    return {
      deps: {
        repo: r, router: B, alarmBook: B, multicall3: B, morpho: B, account: A, paidOnly: false, now: () => 1001,
        send: async () => { sent++; return TX; },
        client: {
          readContract: async (a: { functionName: string }) => read(a),
          // Three balance reads, the exit, then the same reads again: the owner gains, and nobody else's balance moves.
          simulateCalls: async ({ calls }: { calls: unknown[] }) => ({ results: calls.map((_, i) => ({ status: "success", data: i === 4 ? OK : ZERO_WORD })) }),
        },
      } as unknown as KeeperDeps,
      sentCount: () => sent,
    };
  }
  const stableToken = "0x00000000000000000000000000000000000000d4";

  test("a full-sized exit that only partly paid stays open for a retry", async () => {
    const { deps, sentCount } = exitDeps({ shares: 90n, allowance: 90n });
    expect(await runExit(deps, job)).toBe("retry");
    expect(sentCount()).toBe(1);
  });

  test("an exit is done only when the chain shows nothing left", async () => {
    const { deps } = exitDeps({ shares: 0n, allowance: 0n });
    expect(await runExit(deps, job)).toBe("done");
  });

  test("one key that reverts doesn't stop the keys behind it", async () => {
    await db.query(`INSERT INTO plans (wallet, paid_until) VALUES ($1, 9999999999)`, [A]);
    for (const [pos, key] of [[`0x${"01".repeat(32)}`, `0x${"a1".repeat(32)}`], [`0x${"02".repeat(32)}`, `0x${"b2".repeat(32)}`]] as [Hex, Hex][]) {
      await r.upsertPosition({ posId: pos, owner: A, adapter: B, target: V, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "x", keys: [key] });
    }
    const poked: string[] = [];
    const deps = {
      repo: r, alarmBook: B, paidOnly: false, now: () => 1,
      client: {
        call: checkNode({ answer: (key) => (key.startsWith("0xa1") ? "revert" : true) }),
      },
      send: async (tx: { data: string }) => { poked.push(tx.data); return TX; },
    } as unknown as KeeperDeps;
    expect(await pokeTripped(deps)).toEqual([`0x${"b2".repeat(32)}`]);
  });

  test("checking many armed keys takes one request per twenty keys, not one per key, each with an explicit gas", async () => {
    await db.query(`INSERT INTO plans (wallet, paid_until) VALUES ($1, 9999999999)`, [A]);
    const n = 300;
    for (let i = 0; i < n; i++) {
      const hex = i.toString(16).padStart(4, "0");
      await r.upsertPosition({ posId: `0x${hex.repeat(16)}`, owner: A, adapter: B, target: V, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "x", keys: [`0x${"c".repeat(60)}${hex}`] });
    }
    const seen: CheckRequest[] = [];
    const deps = {
      repo: r, alarmBook: B, multicall3: A, paidOnly: false, now: () => 1,
      client: {
        readContract: async () => { throw new Error("checks must be batched"); },
        call: checkNode({ answer: () => false, seen }),
      },
      send: async () => TX,
    } as unknown as KeeperDeps;
    expect(await pokeTripped(deps)).toEqual([]);
    expect(seen.map((q) => q.keys.length)).toEqual(Array.from({ length: n / CHECKS_PER_CALL }, () => CHECKS_PER_CALL));
    expect(seen.every((q) => q.shared && q.gas === CHECK_CALL_GAS)).toBe(true);
  });

  test("an unpaid key costs Canopy's keeper nothing", async () => {
    await r.upsertPosition({ posId: POS, owner: A, adapter: B, target: V, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "x", keys: [KEY] });
    expect(await r.liveKeys(1000)).toEqual([]);
    expect(await r.liveKeys()).toEqual([KEY]);
    await r.setPaidUntil(A, 2000);
    expect(await r.liveKeys(1000)).toEqual([KEY]);
    expect(await r.liveKeys(3000)).toEqual([]);
  });
});

describe("exit bundles", () => {
  const stable = "0x00000000000000000000000000000000000000d4" as Address;
  const OK = `0x${"00".repeat(31)}01` as Hex;
  const ZERO = `0x${"00".repeat(32)}` as Hex;
  const owner = (i: number) => `0x${(0xa00 + i).toString(16).padStart(40, "0")}` as Address;
  const pos = (i: number) => `0x${(0x100 + i).toString(16).padStart(64, "0")}` as Hex;
  const V2 = "0x00000000000000000000000000000000000000c4" as Address;

  const queue = async (i: number, target: Address = V, firedAt = 1000) => {
    const job: ExitJob = { posId: pos(i), key: KEY, owner: owner(i), target, firedAt };
    await enqueueExit(r, `job-${i}`, job, 1);
  };

  const bundled = (tx: { data: Hex }) => (decodeFunctionData({ abi: multicall3Abi, data: tx.data }).args![0] as readonly { allowFailure: boolean; callData: Hex }[]);

  /** A chain where every exit passes unless `refuse` names it, and shares clear unless `stuck` names the owner. */
  function bundleDeps(o: { refuse?: number[]; stuck?: Address[]; gasEach?: bigint; failSim?: boolean; revert?: boolean; now?: number } = {}) {
    const sent: { to: Address; data: Hex; gas?: bigint }[] = [];
    const landed = new Set<string>();
    const land = (data: Hex) => landed.add(owner(Number(BigInt(decodeFunctionData({ abi: routerAbi, data }).args![0] as Hex)) - 0x100));
    const holds = (w: Address) => (landed.has(w) && !o.stuck?.includes(w) ? 0n : 100n);
    const deps = {
      repo: r, router: B, alarmBook: B, multicall3: A, morpho: B, account: A, paidOnly: false, now: () => o.now ?? 1001,
      send: async (tx: { to: Address; data: Hex; gas?: bigint }) => {
        if (o.revert) throw new Error("reverted");
        sent.push(tx);
        if (tx.to === A) for (const c of bundled(tx)) land(c.callData);
        else land(tx.data);
        return TX;
      },
      client: {
        multicall: async ({ contracts }: { contracts: { args: Address[]; functionName: string }[] }) =>
          contracts.map((c) => (c.functionName === "balanceOf" ? holds(c.args[0]!) : 100n)),
        readContract: async ({ functionName, args }: { functionName: string; args: Address[] }) => {
          if (functionName === "asset") return stable;
          if (functionName === "balanceOf" || functionName === "allowance") return holds(args[0]!);
          throw new Error("not v2");
        },
        simulateCalls: async ({ calls }: { calls: unknown[] }) => {
          if (o.failSim && calls.length > 7) throw new Error("node refused");
          return {
            results: calls.map((_, i) => ({
              status: i % 7 === 3 && o.refuse?.includes((i - 3) / 7) ? "failure" : "success",
              data: i % 7 === 4 ? OK : ZERO,
              gasUsed: i % 7 === 3 ? (o.gasEach ?? 500_000n) : 30_000n,
            })),
          };
        },
      },
    } as unknown as KeeperDeps;
    return { deps, sent, landed };
  }

  test("exits in one vault share a transaction, and the gas limit comes from the simulation", async () => {
    for (const i of [1, 2, 3]) await queue(i);
    const { deps, sent } = bundleDeps();
    await drainExits(deps);
    expect(sent.length).toBe(1);
    expect(bundled(sent[0]!).length).toBe(3);
    // An estimate could settle on a limit where the exits fail and the bundle still succeeds.
    // Each exit in it also gets room for its own swap quote, which skips if it cannot get its gas.
    expect(sent[0]!.gas).toBe((1_500_000n * 3n) / 2n + 100_000n + 3n * EXIT_SWAP_HEADROOM);
    expect(await r.dueJobs("exit", 2000)).toEqual([]);
  });

  test("one exit failing can't sink the bundle", async () => {
    for (const i of [1, 2]) await queue(i);
    const { deps, sent } = bundleDeps();
    await drainExits(deps);
    expect(bundled(sent[0]!).every((c) => c.allowFailure)).toBe(true);
  });

  test("different vaults never share a transaction", async () => {
    await queue(1); await queue(2); await queue(3, V2); await queue(4, V2);
    const { deps, sent } = bundleDeps();
    await drainExits(deps);
    expect(sent.map((x) => bundled(x).length)).toEqual([2, 2]);
  });

  test("an exit the gate turns down goes on alone, and the rest still leave", async () => {
    for (const i of [1, 2, 3]) await queue(i);
    const { deps, sent, landed } = bundleDeps({ refuse: [1] });
    await drainExits(deps);
    expect(bundled(sent[0]!).length).toBe(2);
    expect(landed.has(owner(1)) && landed.has(owner(3))).toBe(true);
    expect(sent[1]!.to).toBe(B); // The one the gate refused, sized and sent on its own.
  });

  test("what doesn't fit the gas budget stays due for the next pass, with no penalty", async () => {
    for (const i of [1, 2, 3]) await queue(i);
    const { deps, sent } = bundleDeps({ gasEach: BUNDLE_GAS / 2n });
    await drainExits(deps);
    expect(bundled(sent[0]!).length).toBe(2);
    const left = await r.dueJobs("exit", 1);
    expect(left.length).toBe(1);
    expect(left[0]!.attempts).toBe(0);
  });

  test("an exit that didn't land stays open for a retry", async () => {
    for (const i of [1, 2]) await queue(i);
    const { deps } = bundleDeps({ stuck: [owner(2)] });
    await drainExits(deps);
    const left = await r.dueJobs("exit", 2000);
    expect(left.map((x) => (x.payload as ExitJob).owner)).toEqual([owner(2)]);
    expect(left[0]!.attempts).toBe(1);
  });

  test("a job past the alarm's life is closed, not sent", async () => {
    for (const i of [1, 2]) await queue(i);
    const { deps, sent } = bundleDeps({ now: 1000 + 86_401 });
    await drainExits(deps);
    expect(sent).toEqual([]);
    expect(await r.dueJobs("exit", 200_000)).toEqual([]);
  });

  test("a job with nothing left is closed without a transaction", async () => {
    for (const i of [1, 2]) await queue(i);
    const { deps, sent, landed } = bundleDeps();
    landed.add(owner(1));
    landed.add(owner(2));
    await drainExits(deps);
    expect(sent).toEqual([]);
    expect(await r.dueJobs("exit", 2000)).toEqual([]);
  });

  test("a node that refuses a large simulation drops back to one by one", async () => {
    for (const i of [1, 2]) await queue(i);
    const { deps, sent } = bundleDeps({ failSim: true });
    await drainExits(deps);
    expect(sent.map((x) => x.to)).toEqual([B, B]);
    expect(await r.dueJobs("exit", 2000)).toEqual([]);
  });

  test("a reverted bundle leaves every job open", async () => {
    for (const i of [1, 2]) await queue(i);
    const { deps } = bundleDeps({ revert: true });
    await drainExits(deps);
    expect((await r.dueJobs("exit", 2000)).length).toBe(2);
  });

  test("an estimate gets room for a vault that costs more by the time the transaction lands", () => {
    // The failure this guards against: 482,098 of a 487,682 limit used, out of gas on the last transfer.
    expect(withMargin(487_682n)).toBeGreaterThan(600_000n);
  });
});

describe("indexer resilience", () => {
  test("a window as large as the contract allows fits", async () => {
    await db.query(`INSERT INTO detectors (key, kind, target, threshold, window_s, a, b) VALUES ($1,2,$2,0,$3,'','')`, [KEY, V, 4_294_967_295]);
    expect(await r.detectorKind(KEY)).toBe(2);
  });

  // A log that keeps failing is parked and retried, never skipped: see retry.test.ts.

  test("a payment survives a failure between recording it and applying it", async () => {
    const p = { tx: TX, logIndex: 1, wallet: A, amount: 15n, credited: true, at: 1 };
    expect(await r.recordPayment(p)).toBe(true);
    expect(await r.recordPayment(p)).toBe(true); // the replay after a crash
    await r.applyPayment(TX, 1, A, 5000);
    expect(await r.paidUntil(A)).toBe(5000);
    expect(await r.recordPayment(p)).toBe(false);
    await r.applyPayment(TX, 1, A, 9000);
    expect(await r.paidUntil(A)).toBe(5000);
  });
});

describe("watcher resilience", () => {
  const label = { label: "EXPLOIT_CONFIRMED", protocol: "Spark", confidence: 0.9 } as const;

  test("a report seen during an outage is labelled when the service returns", async () => {
    const up = await ingestFeed(db, async () => null, "https://a.example", "report", 1);
    expect(up).toBeNull();
    expect((await ingestFeed(db, async () => label, "https://a.example", "report", 2))?.classification.label).toBe("EXPLOIT_CONFIRMED");
    expect((await recentReports(db, 1)).map((x) => x.classification.protocol)).toEqual(["Spark"]);
  });

  test("a labelled report isn't paid for twice, and a hopeless one stops after a few tries", async () => {
    let calls = 0;
    const count = async () => { calls++; return label; };
    await ingestFeed(db, count, "https://a.example", "once", 1);
    await ingestFeed(db, count, "https://a.example", "once", 2);
    expect(calls).toBe(1);
    let refused = 0;
    for (let i = 0; i < 9; i++) await ingestFeed(db, async () => { refused++; return null; }, "https://a.example", "refused", i);
    expect(refused).toBe(5);
  });

  const vaults = ["Spark USDC", "Steakhouse USDC", "Gauntlet USDC Prime", "Ethena USDC", "Canopy Test Vault"].map((name) => ({ name }));
  const names = (p: string) => matchVaults(p, vaults).map((v) => v.name);

  test("a token symbol or a stray word matches nothing", () => {
    for (const p of ["USDC", "USD", "eth", "the", "Prime", ""]) expect(names(p)).toEqual([]);
  });

  test("real ways of naming a protocol still match", () => {
    expect(names("Spark Protocol")).toEqual(["Spark USDC"]);
    expect(names("SparkLend")).toEqual(["Spark USDC"]);
    expect(names("Steakhouse Financial")).toEqual(["Steakhouse USDC"]);
    expect(names("Gauntlet USDC Prime")).toEqual(["Gauntlet USDC Prime"]);
  });

  test("a report that only names the platform concerns no vault: it has to name the vault, curator or asset", () => {
    expect(names("Morpho Blue")).toEqual([]);
    expect(names("Morpho Steakhouse")).toEqual(["Steakhouse USDC"]);
  });

  test("a high-s signature copy is refused, so it can't shut out the real one", () => {
    const r32 = "11".repeat(32);
    expect(isHighS(`0x${r32}${"ff".repeat(32)}1b`)).toBe(true);
    expect(isHighS(`0x${r32}${"11".repeat(32)}1b`)).toBe(false);
  });

  test("capital parked across one reading can't fake a drain", () => {
    const samples = [100n, 150n, 100n].map((totalAssets, t) => ({ t, totalAssets }));
    expect(drainVelocity(samples, 3600, 2500n, V)).toBeNull();
  });

  test("a drain still shows against the usual level", () => {
    const samples = [100n, 100n, 100n, 40n].map((totalAssets, t) => ({ t, totalAssets }));
    expect(drainVelocity(samples, 3600, 2500n, V)?.value).toBe(6000);
  });
});

describe("feeds under attack", () => {
  const NOW = Date.parse("2026-11-02T00:00:00Z") / 1000;

  test("markup hidden in CDATA can't add or split items", () => {
    const body = `<rss><channel><item><title><![CDATA[Real title</title></item><item><title>Injected]]></title></item></channel></rss>`;
    const out = feedItems(body, NOW);
    expect(out).toHaveLength(1);
  });

  test("a NUL character can't reach the database", () => {
    expect(feedItems("<rss><item><title>a\0b</title></item></rss>", NOW)[0]).toBe("ab");
  });

  test("full post text in content:encoded is read", () => {
    expect(feedItems(`<rss><item><title>t</title><content:encoded><![CDATA[<p>body</p>]]></content:encoded></item></rss>`, NOW)[0]).toBe("t. body");
  });
});

describe("api limits", () => {
  const api = (extra = {}) => createApi({ db, repo: r, vaults: async () => [], liveAlarms: async () => [], watchers: [], alarmBook: A, chainId: 8453, now: () => 1, ...extra });

  test("a huge body is refused before it's parsed", async () => {
    const res = await api().request("/watcher/attest", { method: "POST", body: "x".repeat(70_000), headers: { "content-length": "70000" } });
    expect(res.status).toBe(413);
  });

  test("/health needs its token, and stays off without one", async () => {
    const on = api({ health: async () => ({ ok: true }), healthToken: "t".repeat(16) });
    expect((await on.request("/health")).status).toBe(403);
    const ok = await on.request("/health", { headers: { authorization: `Bearer ${"t".repeat(16)}`, "x-forwarded-for": "203.0.113.9, 198.51.100.7" } });
    expect(ok.status).toBe(200);
    // The operator sees which address the read limit counts, one proxy hop from the end by default.
    expect(((await ok.json()) as { caller: unknown }).caller).toEqual({ forwardedFor: "203.0.113.9, 198.51.100.7", realIp: null, countedAs: "198.51.100.7" });
    const unset = api({ health: async () => ({ ok: true }) });
    expect((await unset.request("/health")).status).toBe(403);
    expect((await unset.request("/health", { headers: { authorization: "Bearer undefined" } })).status).toBe(403);
  });
});

describe("preset check", () => {
  test("only a vault's own presets count, including their parts", () => {
    const [first] = registrationOrder(V);
    expect(isPreset(V, keyOf(first!))).toBe(true);
    expect(isPreset(V, KEY)).toBe(false);
    expect(isPreset(A, keyOf(first!))).toBe(false);
  });
});
