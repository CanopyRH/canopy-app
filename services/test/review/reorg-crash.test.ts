// Review V3-S06. checkReorg's comment says a crash between its steps is safe: "Undo first, then move the cursor, then
// forget. A crash in between repeats the undo... and the stale hashes are ignored once the cursor is behind them." That
// held for the hashes but not for the retry list. dropFrom also deleted logs parked from the dropped blocks; if the
// process stopped after setCursor and before dropFrom, the next pass saw no reorg (the cursor is already behind the stale
// hashes) and retryParked applied the parked log from a block that is no longer on the chain. For the payments reader
// that credited a plan for a transfer that doesn't exist. Fixed: the parked logs of the dropped blocks go before the
// cursor moves, and a parked log at or beyond the cursor is never retried. Mock chain and the test database.
import { beforeEach, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { erc20Abi } from "../../src/chain/abi";
import { applyPayment, syncLogs, type Log } from "../../src/indexer/indexer";
import type { Db } from "../../src/store/db";
import { repo, type Repo } from "../../src/store/repo";
import { freshDb } from "../db";

const PAYER = "0x00000000000000000000000000000000000000a1" as Address;
const PAYEE = "0x00000000000000000000000000000000000000b2" as Address;
const TOKEN = "0x00000000000000000000000000000000000000c3" as Address;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

/** Block hashes depend on the fork; logs come with the hash of the block they're in now. */
function chain() {
  const c = {
    head: 110n,
    fork: 1n,
    logs: [] as Log[],
    hash: (n: bigint) => `0x${((n >= 100n ? c.fork : 1n) * 1_000_000n + n).toString(16).padStart(64, "0")}` as Hex,
    client: {
      getBlockNumber: async () => c.head,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: c.hash(blockNumber) }),
      getLogs: async (o: { fromBlock: bigint; toBlock: bigint }) =>
        c.logs.filter((l) => l.blockNumber! >= o.fromBlock && l.blockNumber! <= o.toBlock).map((l) => ({ ...l, blockHash: c.hash(l.blockNumber!) })),
    } as never,
  };
  return c;
}

const payment: Log = {
  address: TOKEN, blockNumber: 100n, transactionHash: `0x${"77".repeat(32)}`, logIndex: 0,
  data: encodeAbiParameters([{ type: "uint256" }], [15_000_000n]),
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: PAYER, to: PAYEE } }) as never,
};

test("V3-S06: a stop between setCursor and dropFrom can't apply a parked log from a dropped block", async () => {
  const c = chain();
  c.logs = [payment];
  let failOnce = true;
  const opts = (rr: Repo) => ({
    name: "payments", address: TOKEN, startBlock: 90n, now: () => 1_000, retry: { baseSec: 0 },
    onLog: async (l: Log) => {
      // The first try fails (a database blip), so the payment is parked for retry.
      if (failOnce) { failOnce = false; throw new Error("connection reset"); }
      await applyPayment(rr, l, 1_000);
    },
    onRewind: async (from: bigint) => void (await rr.undoPayments(from)),
  });
  await syncLogs(c.client, r, opts(r));
  expect(await r.paidUntil(PAYER.toLowerCase())).toBeNull();
  expect((await r.parkedLogs("payments")).length).toBe(1);

  // A reorg replaces blocks 100 and up; the transfer is gone for good.
  c.fork = 2n;
  c.logs = [];
  // The process stops right after moving the cursor back (a deploy, a crash): dropFrom never runs.
  const stops = { ...r, dropFrom: async () => { throw new Error("process stopped"); } } as Repo;
  await expect(syncLogs(c.client, stops, opts(stops))).rejects.toThrow("process stopped");
  expect(await r.cursor("payments")).toBe(90n);

  // The parked log went before the cursor moved, so the restarted process has nothing to retry from the dropped block.
  expect((await r.parkedLogs("payments")).length).toBe(0);

  // The restarted process: no reorg is seen, and no plan is credited for a transfer that is not on chain.
  await syncLogs(c.client, r, opts(r));
  expect((await r.parkedLogs("payments")).length).toBe(0);
  expect(await r.paidUntil(PAYER.toLowerCase())).toBeNull();
});

test("V3-S06 (belt and braces): a parked log at or beyond the cursor is never retried", async () => {
  const c = chain();
  c.logs = [payment];
  let failOnce = true;
  const opts = {
    name: "payments", address: TOKEN, startBlock: 90n, now: () => 1_000, retry: { baseSec: 0 },
    onLog: async (l: Log) => {
      if (failOnce) { failOnce = false; throw new Error("connection reset"); }
      await applyPayment(r, l, 1_000);
    },
  };
  await syncLogs(c.client, r, opts);
  expect((await r.parkedLogs("payments")).length).toBe(1);
  // Whatever left the list behind (an older build, a partial restore), the cursor is behind the parked log's block.
  await r.setCursor("payments", 100n);
  c.logs = [];
  await syncLogs(c.client, r, opts);
  expect(await r.paidUntil(PAYER.toLowerCase())).toBeNull();
});
