// Review V3-S01. The contract switch clears the shared database once, but nothing stopped a process still configured for
// the old contracts (an old copy during a rolling deploy, or a service whose env wasn't updated) from writing to it
// afterwards. The reviewed code shared the router and alarms cursors by name, not by address, so:
//   A. an old indexer running after the switch moved the shared cursor to the tip, and the v2 indexer then started there
//      and never read the v2 logs in between;
//   B. an old indexer pass that read the cursor before the switch wrote its own cursor back after it, undoing the rewind;
//   C. any later start of a process with stale addresses switched the database back, wiping v2 positions and exit jobs.
// Fixed by naming the cursors for the contract they follow, refusing a start on other addresses unless the operator set
// CONTRACT_SWITCH, and checking the stored addresses before a reader or the keeper writes. Each outcome is asserted safe
// here. Runs on real Postgres when TEST_DATABASE_URL is set.
import { beforeEach, describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { routerAbi } from "../../src/chain/abi";
import { applyRouterLog, syncLogs, type Log } from "../../src/indexer/indexer";
import { onFired, type KeeperDeps } from "../../src/keeper/keeper";
import type { Db } from "../../src/store/db";
import { repo, type Repo } from "../../src/store/repo";
import { contractFence, ContractMismatch, routerCursor, SwitchRefused, switchContracts } from "../../src/store/switch";
import { freshDb } from "../db";

const V1 = { router: "0x00000000000000000000000000000000000000a1" as Address, alarmBook: "0x00000000000000000000000000000000000000a2" as Address, startBlock: 100n };
const V2 = { router: "0x00000000000000000000000000000000000000b1" as Address, alarmBook: "0x00000000000000000000000000000000000000b2" as Address, startBlock: 5_000n };
const ADAPTER = "0x00000000000000000000000000000000000000c1" as Address;
const VAULT = "0x00000000000000000000000000000000000000c2" as Address;
const V1_USER = "0x00000000000000000000000000000000000000d1" as Address;
const V2_USER = "0x00000000000000000000000000000000000000d2" as Address;
// A preset key is keccak(kind, target, threshold, window, a, b): it doesn't depend on the AlarmBook, so v1 and v2 share it.
const PRESET_KEY = `0x${"7e".repeat(32)}` as Hex;
const V1_POS = `0x${"a1".repeat(32)}` as Hex;
const V2_POS = `0x${"b2".repeat(32)}` as Hex;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

function armedLog(router: Address, block: bigint, posId: Hex, owner: Address, n: number): Log {
  const ev = routerAbi.find((x) => x.type === "event" && x.name === "Armed")!;
  const data = encodeAbiParameters(
    (ev as { inputs: readonly { indexed?: boolean; type: string; name: string }[] }).inputs.filter((i) => !i.indexed),
    [ADAPTER, VAULT, 0n, 0, 0, `0x${"33".repeat(32)}`, [PRESET_KEY]] as never,
  );
  return {
    address: router, blockNumber: block, transactionHash: tx(n), logIndex: 0, data,
    topics: encodeEventTopics({ abi: routerAbi, eventName: "Armed", args: { posId, owner } as never }) as never,
  };
}

/** One chain, both routers' logs on it, served by address like a real node. */
function chain(head: bigint, logs: Log[], beforeLogs?: () => Promise<void>) {
  return {
    getBlockNumber: async () => head,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: `0x${blockNumber.toString(16).padStart(64, "0")}` }),
    getLogs: async (o: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
      if (beforeLogs) await beforeLogs();
      return logs
        .filter((l) => l.address.toLowerCase() === o.address.toLowerCase() && l.blockNumber! >= o.fromBlock && l.blockNumber! <= o.toBlock)
        .map((l) => ({ ...l, blockHash: `0x${l.blockNumber!.toString(16).padStart(64, "0")}` }));
    },
  } as never;
}

let db: Db;
let r: Repo;
/** A router reader as the service runs it: cursor named for its router, and the stored-address fence on. */
const sync = (client: never, cfg: typeof V1) =>
  syncLogs(client, r, {
    name: routerCursor(cfg.router), address: cfg.router, startBlock: cfg.startBlock, now: () => 1_000, onLog: (l) => applyRouterLog(r, l),
    fence: contractFence(db, cfg),
  });
const positions = async () => (await db.query<{ pos_id: string }>(`SELECT pos_id FROM positions ORDER BY pos_id`)).map((x) => x.pos_id.toLowerCase());

// v2 was deployed at 5,000. A user armed on v2 at 5,050 (or register-presets ran then), while v1 kept running and a v1
// user armed at 5,100. Before the switch, this database was on v1 (meta stored, cursor at the tip).
const LOGS = [armedLog(V2.router, 5_050n, V2_POS, V2_USER, 1), armedLog(V1.router, 5_100n, V1_POS, V1_USER, 2)];
const HEAD = 6_000n;
const SWITCH = V2.router; // CONTRACT_SWITCH on the deploy that moves the database

beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
  await db.query(`INSERT INTO meta (key, value) VALUES ('router',$1), ('alarm_book',$2)`, [V1.router, V1.alarmBook]);
  await r.upsertPosition({ posId: `0x${"99".repeat(32)}`, owner: V1_USER, adapter: ADAPTER, target: VAULT, tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 200n, termsHash: "t", keys: [PRESET_KEY] });
  await r.setCursor(routerCursor(V1.router), HEAD + 1n);
});

describe("V3-S01: the contract switch fences processes still on the old addresses", () => {
  test("control: before the switch the v1 reader works as it always did", async () => {
    await r.setCursor(routerCursor(V1.router), 5_000n);
    await sync(chain(HEAD, LOGS), V1);
    expect(await positions()).toContain(V1_POS.toLowerCase());
  });

  test("A. an old indexer running after the switch can't start (fence) and can't move the v2 cursor (its cursor has its own name)", async () => {
    const c = chain(HEAD, LOGS);
    expect(await switchContracts(db, V2, SWITCH)).not.toBeNull();
    expect(await r.cursor(routerCursor(V2.router))).toBe(4_999n);
    // The v1 indexer hasn't been restarted yet (another service, or the old copy in a rolling deploy). Its next pass stops.
    await expect(sync(c, V1)).rejects.toBeInstanceOf(ContractMismatch);
    expect(await r.cursor(routerCursor(V2.router))).toBe(4_999n);
    expect(await positions()).toEqual([]); // nothing of v1's was written into the v2 database
    // Even a reader with no fence (an old binary) moves only its own, differently named cursor.
    await syncLogs(c, r, { name: routerCursor(V1.router), address: V1.router, startBlock: V1.startBlock, now: () => 1_000, onLog: async () => {} });
    expect(await r.cursor(routerCursor(V2.router))).toBe(4_999n);
    // The v2 indexer runs and reads the v2 arm at 5,050, and never the v1 arm.
    expect(await switchContracts(db, V2)).toBeNull();
    await sync(c, V2);
    const now = await positions();
    expect(now).toContain(V2_POS.toLowerCase());
    expect(now).not.toContain(V1_POS.toLowerCase());
  });

  test("A (cont). a v2 alarm queues an exit for the v2 position only, never for a stale v1 one sharing the preset key", async () => {
    const c = chain(HEAD, LOGS);
    await switchContracts(db, V2, SWITCH);
    await expect(sync(c, V1)).rejects.toBeInstanceOf(ContractMismatch);
    await sync(c, V2);
    await r.setPaidUntil(V1_USER.toLowerCase(), 10_000_000);
    await r.setPaidUntil(V2_USER.toLowerCase(), 10_000_000);
    const d = { repo: r, paidOnly: true, now: () => 1_000 } as unknown as KeeperDeps;
    expect(await onFired(d, PRESET_KEY, 1_000)).toBe(1);
    const jobs = await db.query<{ payload: { posId: string } }>(`SELECT payload FROM jobs WHERE kind='exit'`);
    expect(jobs.map((j) => j.payload.posId.toLowerCase())).toEqual([V2_POS.toLowerCase()]);
  });

  test("a keeper started on the old addresses is fenced out too", async () => {
    await switchContracts(db, V2, SWITCH);
    const d = { repo: r, paidOnly: true, now: () => 1_000, fence: contractFence(db, V1) } as unknown as KeeperDeps;
    await expect(onFired(d, PRESET_KEY, 1_000)).rejects.toBeInstanceOf(ContractMismatch);
  });

  test("B. an old indexer pass already in flight when the switch commits writes nothing, and the rewind stays", async () => {
    // The v1 indexer read its cursor (6,001) and is waiting on the node for blocks up to 6,500 when the switch commits.
    let switched = false;
    const later = chain(HEAD + 500n, LOGS, async () => {
      if (switched) return;
      switched = true;
      expect(await switchContracts(db, V2, SWITCH)).not.toBeNull();
      expect(await r.cursor(routerCursor(V2.router))).toBe(4_999n);
    });
    await expect(sync(later, V1)).rejects.toBeInstanceOf(ContractMismatch);
    expect(switched).toBe(true);
    // The rewind to 4,999 is still there, the v1 pass applied nothing, and v2 reads its arm.
    expect(await r.cursor(routerCursor(V2.router))).toBe(4_999n);
    expect(await positions()).toEqual([]);
    await sync(later, V2);
    expect(await positions()).toEqual([V2_POS.toLowerCase()]);
  });

  test("C. a later start with stale v1 addresses refuses to switch back, and v2 positions and exit jobs stay", async () => {
    const c = chain(HEAD, LOGS);
    await switchContracts(db, V2, SWITCH);
    await sync(c, V2);
    expect(await positions()).toContain(V2_POS.toLowerCase());
    await r.enqueue("exit", `${PRESET_KEY}:1000:${V2_POS}`, { posId: V2_POS }, 1_000);
    // A watcher or api service whose env still names v1 restarts (a crash, a redeploy, a config change elsewhere).
    await expect(switchContracts(db, V1)).rejects.toBeInstanceOf(SwitchRefused);
    // Even with the switch variable left set to the new router, v1 addresses don't match it.
    await expect(switchContracts(db, V1, V2.router)).rejects.toBeInstanceOf(SwitchRefused);
    expect(await positions()).toEqual([V2_POS.toLowerCase()]);
    expect(Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE kind='exit' AND NOT done`))[0]!.n)).toBe(1);
    expect(await r.cursor(routerCursor(V2.router))).toBeGreaterThan(4_999n);
    // The v2 deploy keeps starting.
    expect(await switchContracts(db, V2)).toBeNull();
  });
});
