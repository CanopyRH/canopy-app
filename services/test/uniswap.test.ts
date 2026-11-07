import { beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, getAddress, parseAbi, type Address, type Hex } from "viem";
import { routerAbi } from "../src/chain/abi";
import { BASE, ROBINHOOD } from "../src/chain/addresses";
import { drainExits, isNftJob, onFired, runExit, type ExitJob, type KeeperDeps } from "../src/keeper/keeper";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { checkAdapter, enableAdapterFiles } from "../deploy/enable-adapter";
import { type Deployment, type Settings } from "../deploy/plan";
import { freshDb } from "./db";

const NPM = "0x00000000000000000000000000000000000000e1" as Address;
const ROUTER = "0x00000000000000000000000000000000000000b2" as Address;
const KEEPER = "0x00000000000000000000000000000000000000a1" as Address;
const OWNER = "0x0000000000000000000000000000000000000a11" as Address;
const T0 = "0x00000000000000000000000000000000000000f0" as Address;
const STABLE = "0x00000000000000000000000000000000000000d4" as Address;
const TX = `0x${"44".repeat(32)}` as Hex;
const POS = `0x${"11".repeat(32)}` as Hex;
const KEY = `0x${"22".repeat(32)}` as Hex;
const word = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

const job: ExitJob = { posId: POS, key: KEY, owner: OWNER, target: NPM, firedAt: 1000, tokenId: "42" };

interface Lp { holder?: Address; approved?: Address; all?: boolean; liquidity?: bigint; owed?: [bigint, bigint]; burned?: boolean }

/**
 * A chain with one Uniswap v3 position (token0 T0, token1 the stablecoin). The exit empties it once sent.
 * `sim` shapes the simulation: by default the exit succeeds and only the owner gains.
 */
function lpDeps(lp: Lp = {}, sim: { exitFails?: boolean; keeperGains?: boolean; stays?: boolean } = {}) {
  const sent: { to: Address; data: Hex }[] = [];
  let exited = false;
  const read = ({ functionName }: { functionName: string; args?: unknown[] }) => {
    if (functionName === "STABLE") return STABLE;
    if (functionName === "ownerOf") {
      if (lp.burned) throw new Error("ERC721: owner query for nonexistent token");
      return lp.holder ?? OWNER;
    }
    // A single-token approval is spent by the exit, as on chain.
    if (functionName === "getApproved") return exited && !sim.stays ? "0x0000000000000000000000000000000000000000" : (lp.approved ?? ROUTER);
    if (functionName === "isApprovedForAll") return lp.all ?? false;
    if (functionName === "positions") {
      const empty = exited && !sim.stays;
      const [o0, o1] = empty ? [0n, 0n] : (lp.owed ?? [0n, 0n]);
      return [0n, OWNER, T0, STABLE, 500, -10, 10, empty ? 0n : (lp.liquidity ?? 1000n), 0n, 0n, o0, o1];
    }
    throw new Error(`unexpected read ${functionName}`);
  };
  const deps = {
    repo: r, router: ROUTER, alarmBook: ROUTER, multicall3: KEEPER, morpho: KEEPER, account: KEEPER, paidOnly: false, now: () => 1001,
    send: async (tx: { to: Address; data: Hex }) => {
      sent.push(tx);
      exited = true;
      return TX;
    },
    client: {
      readContract: async (a: { functionName: string }) => read(a),
      // Two tokens, three watchers each (owner, router, keeper): six reads, the exit, the same six reads.
      simulateCalls: async ({ calls }: { calls: unknown[] }) => ({
        results: calls.map((_, i) => {
          if (i === 6) return { status: sim.exitFails ? "failure" : "success", data: "0x", gasUsed: 400_000n };
          const ownerGain = i === 7; // owner, token0, after
          const keeperGain = sim.keeperGains && i === 9; // keeper, token0, after
          return { status: "success", data: word(ownerGain || keeperGain ? 5n : 0n), gasUsed: 30_000n };
        }),
      }),
    },
  } as unknown as KeeperDeps;
  return { deps, sent };
}

describe("keeper: Uniswap v3 positions", () => {
  test("a fired alarm queues an LP position with its tokenId, and a vault position with none", async () => {
    await r.upsertPosition({ posId: POS, owner: OWNER, adapter: "lp", target: NPM, tokenId: 42n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [KEY] });
    await r.upsertPosition({ posId: `0x${"12".repeat(32)}`, owner: OWNER, adapter: "4626", target: STABLE, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [KEY] });
    expect(await onFired({ repo: r, paidOnly: false, now: () => 1000 } as never, KEY, 900)).toBe(2);
    const jobs = (await r.dueJobs("exit", 9999)).map((x) => x.payload as ExitJob);
    expect(jobs.filter(isNftJob).map((j) => j.tokenId)).toEqual(["42"]);
    expect(jobs.filter((j) => !isNftJob(j)).length).toBe(1);
  });

  test("jobs queued before this change, with no tokenId, stay on the vault path", () => {
    const { tokenId: _, ...old } = job;
    expect(isNftJob(old)).toBe(false);
    expect(isNftJob({ ...job, tokenId: "0" })).toBe(false);
  });

  test("an armed LP exits whole: one exit call for amount 0, done once the NFT is empty", async () => {
    const { deps, sent } = lpDeps();
    expect(await runExit(deps, job)).toBe("done");
    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe(ROUTER);
    const call = decodeFunctionData({ abi: routerAbi, data: sent[0]!.data });
    expect(call.functionName).toBe("exit");
    expect(call.args).toEqual([POS, KEY, 0n]);
  });

  test("fees owed on an emptied position still get exited", async () => {
    const { deps, sent } = lpDeps({ liquidity: 0n, owed: [0n, 7n] });
    expect(await runExit(deps, job)).toBe("done");
    expect(sent.length).toBe(1);
  });

  test("nothing is sent when there is nothing for the router to move", async () => {
    for (const lp of [
      { holder: "0x0000000000000000000000000000000000000b0b" as Address }, // sold or moved
      { approved: "0x0000000000000000000000000000000000000000" as Address }, // approval revoked
      { liquidity: 0n, owed: [0n, 0n] as [bigint, bigint] }, // empty
    ]) {
      const { deps, sent } = lpDeps(lp);
      expect(await runExit(deps, job)).toBe("done");
      expect(sent.length).toBe(0);
    }
  });

  test("a failed owner read is retried rather than mistaken for a burned NFT", async () => {
    const { deps, sent } = lpDeps({ burned: true });
    await expect(runExit(deps, job)).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  test("an operator approval for the router is enough", async () => {
    const { deps, sent } = lpDeps({ approved: "0x0000000000000000000000000000000000000000", all: true }, { stays: false });
    await runExit(deps, job);
    expect(sent.length).toBe(1);
  });

  test("the gate holds back an exit that reverts or pays the keeper", async () => {
    for (const sim of [{ exitFails: true }, { keeperGains: true }]) {
      const { deps, sent } = lpDeps({}, sim);
      expect(await runExit(deps, job)).toBe("retry");
      expect(sent.length).toBe(0);
    }
  });

  test("an exit that left the position full stays open for a retry", async () => {
    const { deps, sent } = lpDeps({}, { stays: true });
    expect(await runExit(deps, job)).toBe("retry");
    expect(sent.length).toBe(1);
  });

  test("LP positions never share a bundle, though they share a target", async () => {
    for (const i of [1, 2]) {
      const posId = `0x${String(i).repeat(64)}` as Hex;
      await r.upsertPosition({ posId, owner: OWNER, adapter: "lp", target: NPM, tokenId: BigInt(40 + i), harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [KEY] });
      await r.enqueue("exit", `lp-${i}`, { ...job, posId, tokenId: String(40 + i) }, 1);
    }
    const { deps, sent } = lpDeps({}, { stays: true }); // both stay full, so the first exit can't hide the second
    await drainExits(deps);
    expect(sent.map((s) => s.to)).toEqual([ROUTER, ROUTER]);
    expect(sent.map((s) => decodeFunctionData({ abi: routerAbi, data: s.data }).functionName)).toEqual(["exit", "exit"]);
  });
});

describe("admin batch: enable the Uniswap v3 adapter", () => {
  const ADAPTER = "0x00000000000000000000000000000000000000c7" as Address;
  const TIMELOCK = "0x00000000000000000000000000000000000000c1" as Address;
  const d: Deployment = { timelock: TIMELOCK, alarmBook: KEEPER, router: ROUTER, adapter: KEEPER, startBlock: 1 };
  const s = { chainId: 4663, timelockDelay: 0, watchers: [], vaults: [] } as unknown as Settings;
  const timelockAbi = parseAbi([
    "function schedule(address target, uint256 value, bytes data, bytes32 salt) returns (bytes32)",
    "function execute(address target, uint256 value, bytes data, bytes32 salt) payable returns (bytes)",
  ]);

  test("with no delay, one batch schedules and executes setAdapter(adapter, true) through the Timelock", () => {
    const files = enableAdapterFiles(d, s, ADAPTER);
    expect(files.map(([f]) => f)).toEqual(["enable-uniswap-v3-adapter.safe.json"]);
    const batch = files[0]![1];
    expect(batch.chainId).toBe("4663");
    expect(batch.transactions.map((t) => t.to)).toEqual([TIMELOCK, TIMELOCK]);
    const [sched, exec] = batch.transactions.map((t) => decodeFunctionData({ abi: timelockAbi, data: t.data }));
    expect([sched!.functionName, exec!.functionName]).toEqual(["schedule", "execute"]);
    expect(sched!.args).toEqual(exec!.args);
    const [target, value, data, salt] = sched!.args as [Address, bigint, Hex, Hex];
    expect([target, value]).toEqual([ROUTER, 0n]);
    const inner = decodeFunctionData({ abi: routerAbi, data });
    expect(inner.functionName).toBe("setAdapter");
    expect(inner.args).toEqual([getAddress(ADAPTER), true]);

  });

  test("with a delay, schedule and execute are separate batches", () => {
    const files = enableAdapterFiles(d, { ...s, timelockDelay: 3600 }, ADAPTER);
    expect(files.map(([f]) => f)).toEqual(["enable-uniswap-v3-adapter-1-schedule.safe.json", "enable-uniswap-v3-adapter-2-execute-after-delay.safe.json"]);
  });

  const fakeChain = (o: { router?: Address; positions?: Address; allowed?: boolean; code?: Hex } = {}) => ({
    getCode: async () => o.code ?? "0x60",
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "ROUTER") return o.router ?? ROUTER;
      if (functionName === "POSITIONS") return o.positions ?? ROBINHOOD.uniswapV3Positions;
      if (functionName === "positionAsset") return [o.positions ?? ROBINHOOD.uniswapV3Positions, true];
      if (functionName === "adapterAllowed") return o.allowed ?? false;
      throw new Error(functionName);
    },
  }) as never;

  test("the on-chain check passes a correctly wired adapter and names every problem otherwise", async () => {
    expect(await checkAdapter(fakeChain(), d, 4663, ADAPTER)).toEqual([]);
    expect(await checkAdapter(fakeChain({ code: "0x" }), d, 4663, ADAPTER)).toEqual(["no contract at the adapter address"]);
    expect(await checkAdapter(fakeChain({ router: KEEPER }), d, 4663, ADAPTER)).toHaveLength(1);
    expect(await checkAdapter(fakeChain({ positions: BASE.uniswapV3Positions }), d, 4663, ADAPTER)).toHaveLength(1);
    expect(await checkAdapter(fakeChain({ allowed: true }), d, 4663, ADAPTER)).toEqual(["adapter is already enabled"]);
    expect(await checkAdapter(fakeChain({ positions: BASE.uniswapV3Positions }), d, 8453, ADAPTER)).toEqual([]);
  });
});
