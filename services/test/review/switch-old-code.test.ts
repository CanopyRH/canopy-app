// Verification of the V3-S01 fix (b2701a1). New code fences itself, but at the real switch the processes still running
// are the OLD code (4f620a0 and before): no fence, and router/alarms cursors named plain "router" and "alarms". The switch
// deletes those legacy cursors too (`named()` matches 'router' as well as 'router@%'). An old indexer copy still running
// in the rolling-deploy overlap then finds no cursor, falls back to the v1 START_BLOCK and replays the whole v1 history
// into the freshly cleared tables. Its replayed DisarmedAll rows run `disarmAll(owner, epoch)`, which switches off that
// owner's positions with a lower epoch, v2 ones included, and leaves the v1 epoch in owner_epochs, so a later v2 arm
// inherits it and the owner's own v2 disarmAll is then ignored by the database.
//
// The old reader is modelled with today's syncLogs/applyRouterLog called the way 4f620a0's index.ts called them
// (name "router", no fence); those paths are unchanged for this purpose. Runs on real Postgres when TEST_DATABASE_URL is set.
import { beforeEach, describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { routerAbi } from "../../src/chain/abi";
import { applyRouterLog, syncLogs, type Log } from "../../src/indexer/indexer";
import type { Db } from "../../src/store/db";
import { repo, type Repo } from "../../src/store/repo";
import { PARKED_CURSOR, contractFence, routerCursor, switchContracts } from "../../src/store/switch";
import { freshDb } from "../db";

const V1 = { router: "0x00000000000000000000000000000000000000a1" as Address, alarmBook: "0x00000000000000000000000000000000000000a2" as Address, startBlock: 100n };
const V2 = { router: "0x00000000000000000000000000000000000000b1" as Address, alarmBook: "0x00000000000000000000000000000000000000b2" as Address, startBlock: 5_000n };
const ADAPTER = "0x00000000000000000000000000000000000000c1" as Address;
const VAULT = "0x00000000000000000000000000000000000000c2" as Address;
const OWNER = "0x00000000000000000000000000000000000000d1" as Address;
const KEY = `0x${"7e".repeat(32)}` as Hex;
const V1_POS = `0x${"a1".repeat(32)}` as Hex;
const V2_POS = `0x${"b2".repeat(32)}` as Hex;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

function armedLog(router: Address, block: bigint, posId: Hex, n: number): Log {
  const ev = routerAbi.find((x) => x.type === "event" && x.name === "Armed")!;
  const data = encodeAbiParameters(
    (ev as { inputs: readonly { indexed?: boolean; type: string; name: string }[] }).inputs.filter((i) => !i.indexed),
    [ADAPTER, VAULT, 0n, 0, 0, `0x${"33".repeat(32)}`, [KEY]] as never,
  );
  return { address: router, blockNumber: block, transactionHash: tx(n), logIndex: 0, data, topics: encodeEventTopics({ abi: routerAbi, eventName: "Armed", args: { posId, owner: OWNER } as never }) as never };
}
function disarmedAllLog(router: Address, block: bigint, epoch: bigint, n: number): Log {
  return {
    address: router, blockNumber: block, transactionHash: tx(n), logIndex: 0, data: encodeAbiParameters([{ type: "uint64" }], [epoch]),
    topics: encodeEventTopics({ abi: routerAbi, eventName: "DisarmedAll", args: { owner: OWNER } as never }) as never,
  };
}

function chain(head: bigint, logs: Log[], asked: bigint[]) {
  return {
    getBlockNumber: async () => head,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: `0x${blockNumber.toString(16).padStart(64, "0")}` }),
    getLogs: async (o: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
      if (o.address.toLowerCase() === V1.router) asked.push(o.fromBlock);
      return logs
        .filter((l) => l.address.toLowerCase() === o.address.toLowerCase() && l.blockNumber! >= o.fromBlock && l.blockNumber! <= o.toBlock)
        .map((l) => ({ ...l, blockHash: `0x${l.blockNumber!.toString(16).padStart(64, "0")}` }));
    },
  } as never;
}

let db: Db;
let r: Repo;
const HEAD = 6_000n;
// v1 history: the owner armed on v1 and used Disarm All twice (epoch 2). Long before v2.
const V1_LOGS = [armedLog(V1.router, 150n, V1_POS, 1), disarmedAllLog(V1.router, 160n, 1n, 2), disarmedAllLog(V1.router, 170n, 2n, 3)];

/** The reader as the new code runs it. */
const newReader = (c: never) => syncLogs(c, r, { name: routerCursor(V2.router), fence: contractFence(db, V2), address: V2.router, startBlock: V2.startBlock, now: () => 1_000, onLog: (l) => applyRouterLog(r, l) });
/** The reader as 4f620a0 runs it: a plain "router" cursor, no fence. */
const oldReader = (c: never) => syncLogs(c, r, { name: "router", address: V1.router, startBlock: V1.startBlock, now: () => 1_000, onLog: (l) => applyRouterLog(r, l) });
const active = async (posId: Hex) => (await db.query<{ active: boolean }>(`SELECT active FROM positions WHERE lower(pos_id)=$1`, [posId.toLowerCase()]))[0]?.active;

beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
  // Production before the switch: the old code's state, with its plain "router" cursor at the tip.
  const asked: bigint[] = [];
  await oldReader(chain(HEAD, V1_LOGS, asked));
  expect(await r.cursor("router")).toBe(HEAD + 1n);
});

describe("V3V-01 (fixed): the switch parks the old code's cursor past any head, so an old indexer in the overlap reads nothing", () => {
  test("the old reader reads nothing after the switch, and a v2 position armed on chain stays on", async () => {
    // The indexer is deployed first with CONTRACT_SWITCH, as the runbook says.
    expect(await switchContracts(db, V2, V2.router)).not.toBeNull();
    expect(await r.cursor("router")).toBe(PARKED_CURSOR); // parked past any head, not deleted
    expect(await r.cursor("alarms")).toBe(PARKED_CURSOR);
    // The new reader indexes a v2 arm by the same owner (epoch 0 on the v2 router).
    const logs = [...V1_LOGS, armedLog(V2.router, 5_050n, V2_POS, 4)];
    await newReader(chain(HEAD, logs, []));
    expect(await active(V2_POS)).toBe(true);
    // The old indexer copy is still running (rolling-deploy overlap). The deployed code reads only while its cursor is at
    // or below the tip, so with the cursor parked it asks for no logs at all and replays nothing.
    const asked: bigint[] = [];
    const oldCursor = (await r.cursor("router"))!;
    if (oldCursor <= HEAD) await oldReader(chain(HEAD, logs, asked));
    expect(asked).toEqual([]);
    expect(await active(V2_POS)).toBe(true);
    expect((await r.armedWith(KEY)).map((p) => p.pos_id.toLowerCase())).toContain(V2_POS.toLowerCase());
  });

  test("no v1 epoch comes back, so a later v2 arm and the owner's v2 Disarm All are both honoured", async () => {
    await switchContracts(db, V2, V2.router);
    // The overlap copy reads nothing (see above), so the owner's epoch starts clean.
    expect(await r.epochOf(OWNER.toLowerCase())).toBe(0n);
    // Days later the owner arms on v2 (the router's epoch for them is 0), then uses Disarm All on v2 (new epoch 1).
    const later = [...V1_LOGS, armedLog(V2.router, 7_000n, V2_POS, 5), disarmedAllLog(V2.router, 7_100n, 1n, 6)];
    await newReader(chain(8_000n, later, []));
    // On chain the position is off, and so it is in the database: the keeper leaves it alone.
    expect(await active(V2_POS)).not.toBe(true);
    expect((await r.armedWith(KEY)).map((p) => p.pos_id.toLowerCase())).not.toContain(V2_POS.toLowerCase());
  });
});
