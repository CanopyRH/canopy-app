import { beforeEach, describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { erc20Abi, routerAbi } from "../src/chain/abi";
import { BASE, chainParts, ROBINHOOD } from "../src/chain/addresses";
import { Env, loadEnv } from "../src/env";
import { applyPayment, applyRouterLog, confirmArms, syncLogs, type Log } from "../src/indexer/indexer";
import { onFired, type KeeperDeps } from "../src/keeper/keeper";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const V = "0x00000000000000000000000000000000000000c3" as Address;
const ROUTER = "0x00000000000000000000000000000000000000d4" as Address;
const P = `0x${"11".repeat(32)}` as Hex;
const K = `0x${"22".repeat(32)}` as Hex;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

function armedLog(posId = P, block = 7n, termsHash = `0x${"33".repeat(32)}`): Log {
  const ev = routerAbi.find((x) => x.type === "event" && x.name === "Armed")!;
  const topics = encodeEventTopics({ abi: routerAbi, eventName: "Armed", args: { posId, owner: A } as never });
  const data = encodeAbiParameters(
    (ev as { inputs: readonly { indexed?: boolean; type: string; name: string }[] }).inputs.filter((i) => !i.indexed),
    [B, V, 0n, 0, 0, termsHash, [K]] as never,
  );
  return { address: ROUTER, data, topics: topics as never, blockNumber: block, transactionHash: `0x${"44".repeat(32)}`, logIndex: 0 };
}

const payment = (block: bigint, i = 0): Log => ({
  address: V,
  data: encodeAbiParameters([{ type: "uint256" }], [15_000_000n]),
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: A, to: B } }) as never,
  blockNumber: block,
  transactionHash: `0x${(0x50 + i).toString(16).repeat(32)}` as Hex,
  logIndex: i,
});

/** A node whose head is `head`. It answers getLogs only for the range asked, like a real one. */
const node = (head: bigint, logs: Log[]) => {
  const asked: [bigint, bigint][] = [];
  return {
    asked,
    client: {
      getBlockNumber: async () => head,
      getLogs: async (o: { fromBlock: bigint; toBlock: bigint }) => (asked.push([o.fromBlock, o.toBlock]), logs.filter((l) => l.blockNumber! >= o.fromBlock && l.blockNumber! <= o.toBlock)),
    } as never,
  };
};

describe("how deep is deep enough", () => {
  test("the default is about ten seconds of blocks on each chain", () => {
    expect(chainParts(ROBINHOOD.chainId).confirmations).toBe(100n); // 10 blocks a second
    expect(chainParts(BASE.chainId).confirmations).toBe(5n); // a block every 2 seconds
  });

  test("CONFIRMATIONS is optional, a whole number of blocks, and not negative", () => {
    const base = { PUBLIC_URL: "https://x.example", DATABASE_URL: "postgres://x", CHAIN_ID: "4663", RPC_URL: "https://a.example", RPC_URL_BACKUP: "https://b.example", TELEGRAM_BOT_TOKEN: "1:a", TELEGRAM_WEBHOOK_SECRET: "s".repeat(16), ALERTS_ONLY: "true" };
    expect(loadEnv(base).CONFIRMATIONS).toBeUndefined();
    expect(loadEnv({ ...base, CONFIRMATIONS: "20" }).CONFIRMATIONS).toBe(20n);
    expect(loadEnv({ ...base, CONFIRMATIONS: "0" }).CONFIRMATIONS).toBe(0n);
    expect(() => loadEnv({ ...base, CONFIRMATIONS: "-1" })).toThrow();
    expect(() => Env.parse({ ...base, CONFIRMATIONS: "1.5" })).toThrow();
  });
});

describe("plan payments wait for confirmations", () => {
  const credit = async (l: Log) => void (await applyPayment(r, l, 1_000_000));
  const sync = (head: bigint, logs: Log[], confirmations = 100n) =>
    syncLogs(node(head, logs).client, r, { name: "payments", address: V, startBlock: 0n, confirmations, onLog: credit });

  test("a payment in the newest blocks is not credited yet, then is once it is deep enough", async () => {
    const logs = [payment(950n)];
    await sync(1_000n, logs);
    expect(await r.paidUntil(A.toLowerCase())).toBeNull();
    expect(await r.cursor("payments")).toBe(901n); // read up to head - depth
    await sync(1_049n, logs);
    expect(await r.paidUntil(A.toLowerCase())).toBeNull();
    await sync(1_050n, logs);
    expect(await r.paidUntil(A.toLowerCase())).toBe(1_000_000 + 90 * 86_400);
  });

  test("a payment that is reorged away before it is deep enough never credits", async () => {
    await sync(1_000n, [payment(990n)]); // seen at the head, not applied
    await sync(1_200n, []); // the chain moved on without it
    expect(await r.paidUntil(A.toLowerCase())).toBeNull();
    expect((await db.query(`SELECT 1 FROM plan_payments`)).length).toBe(0);
  });

  test("nothing is read while the chain is shorter than the depth", async () => {
    const n = node(50n, [payment(10n)]);
    await syncLogs(n.client, r, { name: "payments", address: V, startBlock: 0n, confirmations: 100n, onLog: credit });
    expect(n.asked).toEqual([]);
    expect(await r.cursor("payments")).toBeNull();
  });

  test("with no depth set, the indexer reads to the head as before", async () => {
    const n = node(1_000n, []);
    await syncLogs(n.client, r, { name: "x", address: V, startBlock: 0n, onLog: async () => {} });
    expect(n.asked.at(-1)![1]).toBe(1_000n);
  });
});

describe("arms are live at once and checked once they are deep", () => {
  const chain = (head: bigint, armed: boolean | Error, reads: { block?: bigint }[] = []) => ({
    getBlockNumber: async () => head,
    readContract: async (o: { blockNumber: bigint; functionName: string; args: unknown[] }) => {
      reads.push({ block: o.blockNumber });
      if (armed instanceof Error) throw armed;
      expect(o.functionName).toBe("isArmed");
      expect(o.args).toEqual([P]);
      return armed;
    },
  }) as never;
  const confirmedOf = async () => (await db.query<{ confirmed: boolean; active: boolean }>(`SELECT confirmed, active FROM positions`))[0]!;

  test("a new arm is usable immediately, so an exit does not wait for the depth", async () => {
    await applyRouterLog(r, armedLog());
    expect((await r.armedWith(K)).length).toBe(1);
    expect(await confirmedOf()).toEqual({ confirmed: false, active: true });
    // It is queued for exit the moment its alarm fires.
    const d = { repo: r, paidOnly: false, now: () => 1_000 } as unknown as KeeperDeps;
    expect(await onFired(d, K, 900)).toBe(1);
  });

  test("it is left alone until its block is deep, and no chain read is made for it", async () => {
    await applyRouterLog(r, armedLog(P, 950n));
    const reads: { block?: bigint }[] = [];
    expect(await confirmArms(chain(1_000n, true, reads), r, ROUTER, 100n)).toBe(0);
    expect(reads).toEqual([]);
    expect((await confirmedOf()).confirmed).toBe(false);
  });

  test("once deep, the router is asked at the settled block and an arm it holds is confirmed", async () => {
    await applyRouterLog(r, armedLog(P, 950n));
    const reads: { block?: bigint }[] = [];
    expect(await confirmArms(chain(1_050n, true, reads), r, ROUTER, 100n)).toBe(0);
    expect(reads).toEqual([{ block: 950n }]);
    expect(await confirmedOf()).toEqual({ confirmed: true, active: true });
    // Confirmed records are not asked about again.
    await confirmArms(chain(1_200n, true, reads), r, ROUTER, 100n);
    expect(reads).toHaveLength(1);
  });

  test("an arm the router does not hold is switched off, with its waiting exit jobs, and counted", async () => {
    await applyRouterLog(r, armedLog(P, 950n));
    const d = { repo: r, paidOnly: false, now: () => 1_000 } as unknown as KeeperDeps;
    await onFired(d, K, 900);
    expect((await r.dueJobs("exit", 1_000)).length).toBe(1);
    expect(await confirmArms(chain(1_100n, false), r, ROUTER, 100n)).toBe(1);
    expect(await confirmedOf()).toEqual({ confirmed: false, active: false });
    expect(await r.armedWith(K)).toEqual([]);
    expect(await r.dueJobs("exit", 1_000)).toEqual([]);
    expect((await r.health(0)).counters.arm_reorged).toBe("1");
    // It is not checked again, and a later alarm queues nothing for it.
    expect(await confirmArms(chain(1_200n, false), r, ROUTER, 100n)).toBe(0);
    expect(await onFired(d, K, 1_100)).toBe(0);
  });

  test("a node that can't answer leaves the record for the next pass", async () => {
    await applyRouterLog(r, armedLog(P, 950n));
    expect(await confirmArms(chain(1_100n, new Error("missing trie node")), r, ROUTER, 100n)).toBe(0);
    expect(await confirmedOf()).toEqual({ confirmed: false, active: true });
    expect(await confirmArms(chain(1_100n, true), r, ROUTER, 100n)).toBe(0);
    expect((await confirmedOf()).confirmed).toBe(true);
  });

  test("a newer arm of the same position is not confirmed or switched off by a check of the older one", async () => {
    await applyRouterLog(r, armedLog(P, 950n, `0x${"33".repeat(32)}`));
    const stale = (await r.unconfirmedArms(1_000n))[0]!;
    await applyRouterLog(r, armedLog(P, 960n, `0x${"77".repeat(32)}`)); // re-armed with new terms
    expect(await r.revokeArm(P, stale.armed_block, stale.terms_hash)).toBe(false);
    await r.confirmArm(P, stale.armed_block, stale.terms_hash);
    expect(await confirmedOf()).toEqual({ confirmed: false, active: true });
  });

  test("a replayed old arm after a disarm is switched off instead of staying armed", async () => {
    await applyRouterLog(r, armedLog(P, 950n));
    await confirmArms(chain(1_100n, true), r, ROUTER, 100n);
    await applyRouterLog(r, armedLog(P, 950n)); // the same log read again
    expect(await confirmedOf()).toEqual({ confirmed: false, active: true });
    expect(await confirmArms(chain(1_300n, false), r, ROUTER, 100n)).toBe(1);
    expect((await confirmedOf()).active).toBe(false);
  });
});
