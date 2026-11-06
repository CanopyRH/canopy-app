// The review's leads, closed: owner swap legs are recorded and their exits run alone; exit jobs end when a rewind removes
// their alarm; a log whose block hash disagrees with the one known for its block is treated as a reorg; and every read and
// simulation the keeper makes for a checkpoint carries a gas limit. Local mocks and the test database.
import { beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, type Address, type Hex } from "viem";
import { presetsFor } from "../src/api/presets";
import { erc20Abi, multicall3Abi, routerAbi } from "../src/chain/abi";
import { applyRouterLog, syncLogs, type Log } from "../src/indexer/indexer";
import { CHECK_ALONE_GAS, checkpointKeys, drainExits, onFired, POKE_CALL_GAS, SWAP_EXIT_GAS, type KeeperDeps } from "../src/keeper/keeper";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const ROUTER = "0x00000000000000000000000000000000000000b0" as Address;
const MC3 = "0x00000000000000000000000000000000000000b2" as Address;
const KEEPER = "0x00000000000000000000000000000000000000b3" as Address;
const TOKEN = "0x00000000000000000000000000000000000000d4" as Address;
const LISTED = "0x00000000000000000000000000000000000000a1" as Address;
const ADAPTER = "0x00000000000000000000000000000000000000c1" as Address;
const KEY = presetsFor(LISTED)[0]!.key;
const FIRED = 1_000;
const TX = `0x${"11".repeat(32)}` as Hex;
const owner = (i: number) => `0x${(0xa00 + i).toString(16).padStart(40, "0")}` as Address;
const pos = (i: number) => `0x${(0x100 + i).toString(16).padStart(64, "0")}` as Hex;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

function routerLog(eventName: string, args: Record<string, unknown>, block: bigint, n: number): Log {
  const ev = routerAbi.find((x) => x.type === "event" && x.name === eventName)! as { inputs: readonly { indexed?: boolean; type: string; name: string }[] };
  const plain = ev.inputs.filter((i) => !i.indexed);
  return {
    address: ROUTER, blockNumber: block, transactionHash: `0x${n.toString(16).padStart(64, "0")}` as Hex, logIndex: n, data: plain.length ? encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never) : "0x",
    topics: encodeEventTopics({ abi: routerAbi, eventName, args: Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]])) } as never) as never,
  } as Log;
}
const armed = (p: Hex, block: bigint, n: number) =>
  routerLog("Armed", { posId: p, owner: owner(1), adapter: ADAPTER, target: LISTED, tokenId: 0n, harbour: 1, maxSlipBps: 50, termsHash: `0x${"33".repeat(32)}`, keys: [KEY] }, block, n);
const legSet = (p: Hex, block: bigint, n: number) =>
  routerLog("SwapLegSet", { posId: p, token: TOKEN, feed: ADAPTER, heartbeat: 3600, tokenDecimals: 18, path: "0x" }, block, n);
const hasSwaps = async (p: Hex) => (await db.query<{ has_swaps: boolean }>(`SELECT has_swaps FROM positions WHERE pos_id=$1`, [p]))[0]!.has_swaps;

describe("owner swap legs", () => {
  test("SwapLegSet marks the position, and arming again without legs clears it", async () => {
    await applyRouterLog(r, armed(pos(1), 10n, 1));
    expect(await hasSwaps(pos(1))).toBe(false);
    await applyRouterLog(r, legSet(pos(1), 10n, 2));
    expect(await hasSwaps(pos(1))).toBe(true);
    await applyRouterLog(r, legSet(pos(1), 10n, 3)); // a second leg: still marked
    expect(await hasSwaps(pos(1))).toBe(true);
    await applyRouterLog(r, armed(pos(1), 20n, 4)); // re-armed, no legs this time
    expect(await hasSwaps(pos(1))).toBe(false);
  });

  const bal = (v: bigint) => encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: v });
  /** Three jobs in one listed vault on its own preset key; `swapper`'s position has legs. */
  async function scenario(swapperGas: bigint) {
    await r.setPaidUntil(owner(1), 10_000_000);
    await r.setPaidUntil(owner(2), 10_000_000);
    await r.setPaidUntil(owner(3), 10_000_000);
    for (const i of [1, 2, 3]) {
      await r.upsertPosition({ posId: pos(i), owner: owner(i), adapter: ADAPTER, target: LISTED, tokenId: 0n, harbour: 1, maxSlipBps: 50, epoch: 0n, block: 1n, termsHash: "t", keys: [KEY] });
    }
    await r.markSwaps(pos(2), true);
    const sent: { to: Address; data: Hex; gas: bigint }[] = [];
    const d = {
      repo: r, router: ROUTER, alarmBook: ROUTER, multicall3: MC3, morpho: ROUTER, account: KEEPER, paidOnly: true, listed: new Set([LISTED.toLowerCase()]), now: () => FIRED,
      client: {
        multicall: async ({ contracts }: { contracts: unknown[] }) => contracts.map(() => 100n),
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "asset") return TOKEN;
          if (functionName === "balanceOf" || functionName === "allowance") return 100n;
          throw new Error("not a Vault V2");
        },
        simulateCalls: async ({ calls }: { calls: { to: Address; data: Hex }[] }) => ({
          results: calls.map((c, i) => {
            if (c.to.toLowerCase() === ROUTER.toLowerCase()) {
              const [p] = decodeFunctionData({ abi: routerAbi, data: c.data }).args as unknown as [Hex];
              return { status: "success", data: "0x" as Hex, gasUsed: p === pos(2) ? swapperGas : 300_000n };
            }
            let k = 1;
            while (k <= 3 && i - k >= 0 && calls[i - k]!.to.toLowerCase() !== ROUTER.toLowerCase()) k++;
            return { status: "success", data: bal(k <= 3 && i - k >= 0 && k === 1 ? 1n : 0n), gasUsed: 30_000n };
          }),
        }),
      },
      send: async (tx: { to: Address; data: Hex; gas: bigint }) => void sent.push(tx),
    } as unknown as KeeperDeps;
    for (const i of [1, 2, 3]) expect(await onFired(d, KEY, FIRED)).toBe(3 - 0 && 3);
    return { d, sent };
  }

  test("an exit for a position with legs is sent alone with its own gas cap; the others still share a transaction", async () => {
    const { d, sent } = await scenario(2_000_000n);
    await drainExits(d, "listed");
    const bundles = sent.filter((s) => s.to.toLowerCase() === MC3.toLowerCase());
    const alone = sent.filter((s) => s.to.toLowerCase() === ROUTER.toLowerCase());
    expect(bundles).toHaveLength(1);
    const inBundle = (decodeFunctionData({ abi: multicall3Abi, data: bundles[0]!.data }).args![0] as readonly { callData: Hex }[]).map((c) => (decodeFunctionData({ abi: routerAbi, data: c.callData }).args as unknown as [Hex])[0]);
    expect(inBundle.sort()).toEqual([pos(1), pos(3)]);
    expect(alone).toHaveLength(1);
    expect((decodeFunctionData({ abi: routerAbi, data: alone[0]!.data }).args as unknown as [Hex])[0]).toBe(pos(2));
    expect(alone[0]!.gas).toBeLessThanOrEqual(SWAP_EXIT_GAS + 1_000_000n);
  });

  test("a swap exit that needs more than the swap cap is not sent, though its vault is listed", async () => {
    const { d, sent } = await scenario(SWAP_EXIT_GAS + 1n);
    await drainExits(d, "listed");
    expect(sent.filter((s) => s.to.toLowerCase() === ROUTER.toLowerCase())).toEqual([]);
    expect(sent.filter((s) => s.to.toLowerCase() === MC3.toLowerCase())).toHaveLength(1); // the plain ones still go
  });
});

describe("a rewind that removes an alarm ends the exit jobs it queued", () => {
  test("undoAlarms deletes the jobs of the dropped firings only", async () => {
    await r.recordAlarm(KEY, 1_000, TX, "e", 50n);
    await r.recordAlarm(KEY, 2_000, TX, "e", 150n);
    await r.setPaidUntil(owner(1), 10_000_000);
    await r.upsertPosition({ posId: pos(1), owner: owner(1), adapter: ADAPTER, target: LISTED, tokenId: 0n, harbour: 1, maxSlipBps: 50, epoch: 0n, block: 1n, termsHash: "t", keys: [KEY] });
    const d = { repo: r, paidOnly: true, now: () => 2_000 } as unknown as KeeperDeps;
    await onFired(d, KEY, 1_000);
    await onFired(d, KEY, 2_000);
    await r.enqueue("alert", "a1", { x: 1 }, 1);
    expect((await r.dueJobs("exit", 3_000)).map((j) => (j.payload as { firedAt: number }).firedAt).sort()).toEqual([1_000, 2_000]);
    await r.undoAlarms(100n);
    expect((await r.dueJobs("exit", 3_000)).map((j) => (j.payload as { firedAt: number }).firedAt)).toEqual([1_000]);
    expect((await r.dueJobs("alert", 3_000)).length).toBe(1);
    // If the firing is still on chain, the re-read queues the exit again.
    await onFired(d, KEY, 2_000);
    expect((await r.dueJobs("exit", 3_000)).length).toBe(2);
  });
});

describe("a log whose block hash disagrees with the chain's is a reorg", () => {
  const hashOf = (n: bigint, fork: number) => `0x${(BigInt(fork) * 1_000_000n + n).toString(16).padStart(64, "0")}` as Hex;
  function chain(logHashFork: number) {
    const log = { ...armed(pos(1), 105n, 1), blockHash: hashOf(105n, logHashFork) };
    return {
      getBlockNumber: async () => 110n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: hashOf(blockNumber, 1) }),
      getLogs: async () => [log],
    } as never;
  }
  const opts = (applied: Log[]) => ({ name: "router", address: ROUTER, startBlock: 100n, now: () => 1_000, onLog: async (l: Log) => void applied.push(l), onRewind: (from: bigint) => r.undoRouter(from) });

  test("control: logs from the hash the node reported for the range are applied", async () => {
    const applied: Log[] = [];
    await syncLogs(chain(1), r, opts(applied));
    expect(applied).toHaveLength(1);
    expect(await r.cursor("router")).toBe(111n);
  });

  test("a log from another fork than the block hash read for the range: nothing is applied and the range is read again", async () => {
    const applied: Log[] = [];
    await syncLogs(chain(2), r, opts(applied));
    expect(applied).toHaveLength(0);
    expect(await r.cursor("router")).toBe(100n);
    expect(Number((await r.health(0)).counters.reorgs_handled)).toBe(1);
    // The next pass, with the nodes agreeing again, reads it.
    await syncLogs(chain(1), r, opts(applied));
    expect(applied).toHaveLength(1);
    expect(await r.cursor("router")).toBe(111n);
  });
});

describe("checkpoints carry a gas limit on every read and simulation", () => {
  test("detector, state, totalAssets reads and the simulated checkpoint all name a gas limit", async () => {
    const DRAIN = `0x${"d1".repeat(32)}` as Hex;
    const reads: { functionName: string; gas?: bigint }[] = [];
    const sims: { gas?: bigint }[] = [];
    const d = {
      repo: r, alarmBook: ROUTER, account: KEEPER, paidOnly: false, now: () => 1_000, listed: new Set<string>(),
      client: {
        readContract: async (a: { functionName: string; gas?: bigint }) => {
          reads.push({ functionName: a.functionName, gas: a.gas });
          if (a.functionName === "detector") return { kind: 4, target: LISTED, window: 3600 };
          if (a.functionName === "state") return [true, 0n, 0n, 1_000n, 0n, 0n, 0n, 0n];
          return 10n; // totalAssets below the lowest reading: a sample is due
        },
        simulateCalls: async ({ calls }: { calls: { gas?: bigint }[] }) => {
          sims.push({ gas: calls[0]!.gas });
          return { results: [{ status: "success", data: "0x", gasUsed: 100_000n }] };
        },
      },
      send: async () => TX,
    } as unknown as KeeperDeps;
    await checkpointKeys(d, [DRAIN]);
    expect(reads.map((x) => x.functionName)).toEqual(["detector", "state", "totalAssets"]);
    expect(reads.every((x) => x.gas === CHECK_ALONE_GAS)).toBe(true);
    expect(sims).toHaveLength(1);
    expect(sims[0]!.gas).toBe(POKE_CALL_GAS);
  });
});
