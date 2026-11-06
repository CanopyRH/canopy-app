// Audit 2: re-runs of the 2026-11-05 PoCs against the current code.
// Local mocks and the in-process database only. Run: bun test test/audit2-fixes.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { createPublicClient, encodeFunctionResult, fallback, http, type Address, type Hex } from "viem";
import { Kind, keyOf } from "../src/api/presets";
import { queueAlert } from "../src/bot/queue";
import { erc20Abi } from "../src/chain/abi";
import { drainExits, type ExitJob, type KeeperDeps } from "../src/keeper/keeper";
import { scrubConsole } from "../src/log";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { quorumScope } from "../src/watcher/scope";
import { freshDb } from "./db";

const X = "0x00000000000000000000000000000000000000e1" as Address; // attacker's "vault"
const ADAPTER = "0x00000000000000000000000000000000000000e2" as Address;
const V = "0x00000000000000000000000000000000000000c3" as Address; // a real vault with a victim's position
const ROUTER = "0x00000000000000000000000000000000000000b0" as Address;
const KEEPER = "0x00000000000000000000000000000000000000a0" as Address;
const TOKEN = "0x00000000000000000000000000000000000000d4" as Address;
const TX = `0x${"11".repeat(32)}` as Hex;
const bal = (v: bigint) => encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: v });

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

describe("H-1 re-run: a vault whose adapter claims 2^255 markets", () => {
  for (const listed of [new Set([V.toLowerCase()]), new Set<string>()]) {
    test(`drainExits finishes and the victim's exit is sent (listed set ${listed.size ? "set" : "empty, every vault deallocates"})`, async () => {
      let reads = 0;
      let victimLeft = 100n;
      const sentTo: string[] = [];
      const client = {
        readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
          reads++;
          await Bun.sleep(0);
          switch (functionName) {
            case "balanceOf": case "allowance": return address === V ? victimLeft : 100n;
            case "asset": return TOKEN;
            case "liquidityAdapter": if (address === X) return ADAPTER; throw new Error("not v2");
            case "forceDeallocatePenalty": return 0n;
            case "marketIdsLength": return 2n ** 255n;
            case "marketIds": return `0x${"77".repeat(32)}`;
            case "market": return [0n, 0n, 0n, 0n, 0n, 0n];
            case "position": return [0n, 0n, 0n];
            default: throw new Error(functionName);
          }
        },
        // The gate passes for the victim's exit; the attacker's never simulates cleanly.
        simulateCalls: async ({ calls }: { calls: { to: Address }[] }) => {
          const exitAt = calls.findIndex((c) => c.to === ROUTER);
          return { results: calls.map((_, i) => (i === exitAt ? { status: "success", data: "0x", gasUsed: 300_000n } : { status: "success", data: bal(i === exitAt + 1 ? 1n : 0n), gasUsed: 1n })) };
        },
      };
      const d = {
        client, repo: r, router: ROUTER, alarmBook: ROUTER, multicall3: ROUTER, morpho: ROUTER, account: KEEPER, now: () => 1_000, paidOnly: true, listed,
        send: async (tx: { to: string }) => {
          sentTo.push(tx.to);
          victimLeft = 0n;
          return TX;
        },
      } as unknown as KeeperDeps;
      const attackerJob: ExitJob = { posId: `0x${"01".repeat(32)}`, key: `0x${"a1".repeat(32)}`, owner: KEEPER, target: X, firedAt: 990 };
      const victimJob: ExitJob = { posId: `0x${"02".repeat(32)}`, key: `0x${"b2".repeat(32)}`, owner: KEEPER, target: V, firedAt: 995 };
      await r.enqueue("exit", "attacker", attackerJob, 990);
      await r.enqueue("exit", "victim", victimJob, 995);
      const outcome = await Promise.race([drainExits(d).then(() => "finished"), Bun.sleep(3_000).then(() => "still running")]);
      expect(outcome).toBe("finished");
      expect(sentTo.length).toBeGreaterThanOrEqual(1);
      expect(reads).toBeLessThan(100);
    });
  }
});

describe("L-2 re-run: the alarm handler only writes a row", () => {
  test("queueing an alert costs the same with 300 followers as with none", async () => {
    for (let chat = 1; chat <= 300; chat++) await r.follow(chat, X);
    const t0 = performance.now();
    await queueAlert(r, X, "alarm text", 100);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(await r.dueJobs("alert", 100)).toHaveLength(1);
  });
});

describe("L-3 re-run: an attacker's QUORUM key on its own contract", () => {
  const key = keyOf({ kind: Kind.QUORUM, target: X, threshold: 2n, window: 0, a: `0x${"00".repeat(31)}01` as Hex, b: `0x${"00".repeat(32)}` as Hex });
  const arm = (owner: string) =>
    r.upsertPosition({ posId: `0x${"0e".repeat(32)}`, owner, adapter: ADAPTER, target: X, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "x", keys: [key] });

  test("is out of scope when armed from an unpaid wallet", async () => {
    await arm("0xunpaid");
    expect(await quorumScope(r, [V.toLowerCase()], () => 100, true)(key, X)).toBe(false);
  });

  test("residual: comes back into scope once the attacker buys one plan", async () => {
    await arm("0xpaid");
    await r.setPaidUntil("0xpaid", 10_000);
    expect(await quorumScope(r, [V.toLowerCase()], () => 100, true)(key, X)).toBe(true);
  });
});

describe("L-4 re-run: an RPC key in the URL path", () => {
  test("viem still puts it in the message, and the scrubbed console drops it", async () => {
    const transport = fallback([http("http://127.0.0.1:9/robinhood/SECRET_PATH_KEY", { retryCount: 0 }), http("http://127.0.0.1:9/backup/SECRET_PATH_KEY", { retryCount: 0 })]);
    const msg = await createPublicClient({ transport }).getBlockNumber().then(() => "", (e) => (e as Error).message);
    expect(msg).toContain("SECRET_PATH_KEY");

    const original = { ...console };
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) console[level] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      scrubConsole();
      console.error("exits", msg);
      console.warn("poke", new Error(msg));
    } finally {
      Object.assign(console, original);
    }
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("SECRET_PATH_KEY");
    expect(lines.join("\n")).toContain("http://127.0.0.1:9/…");
  });
});
