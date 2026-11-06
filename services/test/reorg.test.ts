import { beforeEach, describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { erc20Abi, routerAbi } from "../src/chain/abi";
import { queueOps } from "../src/bot/queue";
import { applyPayment, applyRouterLog, recheckRouter, REORG_WINDOW, syncLogs, type Log, type ReorgInfo } from "../src/indexer/indexer";
import { deepReorgText } from "../src/indexer/retry";
import { onFired, type KeeperDeps } from "../src/keeper/keeper";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { freshDb } from "./db";

const OWNER = "0x00000000000000000000000000000000000000a1" as Address;
const PAYEE = "0x00000000000000000000000000000000000000b2" as Address;
const VAULT = "0x00000000000000000000000000000000000000c3" as Address;
const ROUTER = "0x00000000000000000000000000000000000000d4" as Address;
const TOKEN = "0x00000000000000000000000000000000000000e5" as Address;
const P = `0x${"11".repeat(32)}` as Hex;
const K = `0x${"22".repeat(32)}` as Hex;
const TERMS = `0x${"33".repeat(32)}`;
const hex = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}` as Hex;

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

/**
 * A chain that can be reorged. Block hashes depend on which fork a block is on, logs are served with the hash of the block
 * they are in now, and the router answers from `armed`, `epochs` and `owed`.
 */
class MockChain {
  forks = [{ from: 0n, tag: 1 }];
  logs: Log[] = [];
  armed = new Map<string, boolean>();
  keys = new Map<string, Hex[]>();
  epochs = new Map<string, bigint>();
  owed = new Map<string, bigint>();
  asked: [bigint, bigint][] = [];
  flaky = false;
  constructor(public head: bigint) {}

  hash(n: bigint): Hex {
    const tag = [...this.forks].reverse().find((f) => f.from <= n)!.tag;
    return `0x${(BigInt(tag) * 1_000_000n + n).toString(16).padStart(64, "0")}`;
  }
  /** Blocks from `from` on are replaced, the chain is now `head` long, and `logs` are what the new blocks hold. */
  reorg(from: bigint, head: bigint, logs: Log[] = []) {
    this.forks.push({ from, tag: this.forks.length + 1 });
    this.head = head;
    this.logs = [...this.logs.filter((l) => l.blockNumber! < from), ...logs];
  }
  client = {
    getBlockNumber: async () => this.head,
    getBlock: async (o: { blockNumber: bigint }) => {
      if (this.flaky) throw new Error("rpc down");
      if (o.blockNumber > this.head) throw Object.assign(new Error("Block not found."), { name: "BlockNotFoundError" });
      return { hash: this.hash(o.blockNumber) };
    },
    getLogs: async (o: { fromBlock: bigint; toBlock: bigint }) => {
      this.asked.push([o.fromBlock, o.toBlock]);
      return this.logs.filter((l) => l.blockNumber! >= o.fromBlock && l.blockNumber! <= o.toBlock).map((l) => ({ ...l, blockHash: this.hash(l.blockNumber!) }));
    },
    readContract: async (o: { functionName: string; args: unknown[] }) => {
      const a = String(o.args[0]).toLowerCase();
      if (o.functionName === "isArmed") return this.armed.get(a) ?? false;
      if (o.functionName === "keysOf") return this.keys.get(a) ?? [];
      if (o.functionName === "epochOf") return this.epochs.get(a) ?? 0n;
      if (o.functionName === "owed") return this.owed.get(`${a}:${String(o.args[1]).toLowerCase()}`) ?? 0n;
      throw new Error(`unexpected read ${o.functionName}`);
    },
  } as never;
}

const at = (block: bigint, index: number, tx: Hex, address: Address = ROUTER) => ({ address, blockNumber: block, transactionHash: tx, logIndex: index });

const armedLog = (block: bigint, tx: Hex, posId = P): Log => {
  const ev = routerAbi.find((x) => x.type === "event" && x.name === "Armed")!;
  const data = encodeAbiParameters(
    (ev as { inputs: readonly { indexed?: boolean; type: string; name: string }[] }).inputs.filter((i) => !i.indexed),
    [PAYEE, VAULT, 0n, 0, 0, TERMS, [K]] as never,
  );
  return { ...at(block, 0, tx), data, topics: encodeEventTopics({ abi: routerAbi, eventName: "Armed", args: { posId, owner: OWNER } as never }) as never };
};
const disarmedLog = (block: bigint, tx: Hex): Log => ({
  ...at(block, 0, tx), data: "0x", topics: encodeEventTopics({ abi: routerAbi, eventName: "Disarmed", args: { posId: P, owner: OWNER } as never }) as never,
});
const owedLog = (block: bigint, index: number, tx: Hex, amount: bigint): Log => ({
  ...at(block, index, tx), data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  topics: encodeEventTopics({ abi: routerAbi, eventName: "Owed", args: { owner: OWNER, token: TOKEN } as never }) as never,
});
const paymentLog = (block: bigint, index: number, tx: Hex): Log => ({
  ...at(block, index, tx, VAULT), data: encodeAbiParameters([{ type: "uint256" }], [15_000_000n]),
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: OWNER, to: PAYEE } }) as never,
});

const syncRouter = (c: MockChain, extra: Partial<Parameters<typeof syncLogs>[2]> = {}) =>
  syncLogs(c.client, r, {
    name: "router", address: ROUTER, startBlock: 90n, now: () => 1_000,
    onLog: (l) => applyRouterLog(r, l),
    onRewind: (from) => r.undoRouter(from),
    recheck: (subjects, tip) => recheckRouter(c.client, r, ROUTER, subjects, tip),
    ...extra,
  });
const counter = async (name: string) => (await r.health(0)).counters[name];
const position = async () => (await db.query<{ active: boolean; confirmed: boolean }>(`SELECT active, confirmed FROM positions`))[0];

describe("a different hash at a processed height", () => {
  test("rewinds to just after the newest block that still matches and reads forward, applying nothing twice", async () => {
    const c = new MockChain(110n);
    c.logs = [owedLog(95n, 0, hex(1), 5n), owedLog(105n, 1, hex(2), 7n)];
    const seen: string[] = [];
    const onLog = async (l: Log) => {
      seen.push(`${l.transactionHash}:${l.logIndex}`);
      await applyRouterLog(r, l);
    };
    await syncRouter(c, { onLog });
    expect(await r.cursor("router")).toBe(111n);
    // Blocks 106 and up are replaced. The log in 105 is still on the chain, so it is not read again.
    c.reorg(106n, 115n);
    c.asked = [];
    await syncRouter(c, { onLog });
    expect(c.asked).toEqual([[106n, 115n]]);
    expect(await r.cursor("router")).toBe(116n);
    expect(await counter("reorgs_handled")).toBe("1");
    expect(seen).toEqual([`${hex(1)}:0`, `${hex(2)}:1`]);
    expect((await db.query<{ amount: string }>(`SELECT amount FROM owed`))[0]!.amount).toBe("12");
  });

  test("the hashes of the new blocks are remembered, and a quiet pass rewinds nothing", async () => {
    const c = new MockChain(110n);
    await syncRouter(c);
    c.reorg(100n, 112n);
    await syncRouter(c);
    await syncRouter(c);
    c.head = 114n;
    await syncRouter(c);
    expect(await counter("reorgs_handled")).toBe("1");
  });

  test("a chain that is now shorter than the cursor counts as a reorg", async () => {
    const c = new MockChain(110n);
    await syncRouter(c);
    c.reorg(105n, 104n);
    await syncRouter(c);
    expect(await counter("reorgs_handled")).toBe("1");
    expect(await r.cursor("router")).toBe(105n);
    // The head then grows on the new fork.
    c.head = 108n;
    await syncRouter(c);
    expect(await r.cursor("router")).toBe(109n);
    expect(await counter("reorgs_handled")).toBe("1");
  });

  test("an RPC error while checking is not a reorg", async () => {
    const c = new MockChain(110n);
    await syncRouter(c);
    c.flaky = true;
    await expect(syncRouter(c)).rejects.toThrow("rpc down");
    expect(await r.cursor("router")).toBe(111n);
    expect(await counter("reorgs_handled")).toBeUndefined();
  });

  test("no reorg is tracked for a client that can't read blocks", async () => {
    const c = new MockChain(110n);
    const bare = { getBlockNumber: (c.client as never as { getBlockNumber: () => Promise<bigint> }).getBlockNumber, getLogs: (c.client as never as { getLogs: never }).getLogs } as never;
    await syncLogs(bare, r, { name: "x", address: ROUTER, startBlock: 90n, onLog: async () => {} });
    expect((await db.query(`SELECT 1 FROM block_hashes`)).length).toBe(0);
  });
});

describe("a log that vanishes", () => {
  test("an arm that is gone ends up matching the chain, and its waiting exit jobs end", async () => {
    const c = new MockChain(110n);
    c.logs = [armedLog(108n, hex(3))];
    c.armed.set(P, true);
    await syncRouter(c);
    expect(await position()).toEqual({ active: true, confirmed: false });
    const keeper = { repo: r, paidOnly: false, now: () => 1_000 } as unknown as KeeperDeps;
    expect(await onFired(keeper, K, 900)).toBe(1);

    c.armed.set(P, false);
    c.reorg(107n, 112n); // the arm is not in the new blocks
    await syncRouter(c);
    expect(await position()).toEqual({ active: false, confirmed: false });
    expect(await r.armedWith(K)).toEqual([]);
    expect(await r.dueJobs("exit", 1_000)).toEqual([]);
    expect(await counter("arm_reorged")).toBe("1");
    expect((await db.query(`SELECT 1 FROM reorg_recheck`)).length).toBe(0);
  });

  test("a disarm that is gone switches the record back on, to be confirmed once settled", async () => {
    const c = new MockChain(110n);
    c.logs = [armedLog(100n, hex(3)), disarmedLog(108n, hex(4))];
    c.armed.set(P, false);
    await syncRouter(c);
    expect(await position()).toEqual({ active: false, confirmed: false });

    c.armed.set(P, true);
    c.keys.set(P, [K]);
    c.reorg(107n, 112n, []);
    await syncRouter(c);
    expect(await position()).toEqual({ active: true, confirmed: false });
    expect((await r.armedWith(K)).length).toBe(1);
  });

  test("an owed credit that is gone comes off the balance", async () => {
    const c = new MockChain(110n);
    c.logs = [owedLog(95n, 0, hex(5), 4n), owedLog(108n, 1, hex(6), 6n)];
    c.owed.set(`${OWNER}:${TOKEN}`, 4n);
    await syncRouter(c);
    expect((await db.query<{ amount: string }>(`SELECT amount FROM owed`))[0]!.amount).toBe("10");
    c.reorg(107n, 112n, []);
    await syncRouter(c);
    expect((await db.query<{ amount: string }>(`SELECT amount FROM owed`))[0]!.amount).toBe("4");
  });

  test("a failed re-check is kept and tried again on the next pass", async () => {
    const c = new MockChain(110n);
    c.logs = [armedLog(108n, hex(3))];
    c.armed.set(P, true);
    await syncRouter(c);
    c.armed.set(P, false);
    c.reorg(107n, 112n);
    let calls = 0;
    const recheck = async (subjects: string[], tip: bigint) => {
      if (calls++ === 0) throw new Error("node behind");
      await recheckRouter(c.client, r, ROUTER, subjects, tip);
    };
    await syncRouter(c, { recheck });
    expect((await position())!.active).toBe(true);
    expect((await db.query(`SELECT 1 FROM reorg_recheck`)).length).toBe(1);
    await syncRouter(c, { recheck });
    expect((await position())!.active).toBe(false);
    expect((await db.query(`SELECT 1 FROM reorg_recheck`)).length).toBe(0);
  });

  test("alarms and detectors written by the dropped blocks are removed", async () => {
    const c = new MockChain(101n);
    const sync = () => syncLogs(c.client, r, { name: "alarms", address: ROUTER, startBlock: 90n, onLog: async () => {}, onRewind: (from) => r.undoAlarms(from) });
    await sync();
    c.head = 110n;
    await sync();
    await r.recordAlarm(K, 5_000, hex(7), "0x", 108n);
    await r.recordAlarm(hex(8), 4_000, hex(9), "0x", 100n);
    c.reorg(107n, 112n);
    await sync();
    expect((await db.query<{ key: string }>(`SELECT key FROM alarms`)).map((x) => x.key)).toEqual([hex(8)]);
  });
});

describe("a log that moves to another block", () => {
  test("an owed credit is counted once, even at a new log index", async () => {
    const c = new MockChain(110n);
    c.logs = [owedLog(108n, 1, hex(6), 6n)];
    c.owed.set(`${OWNER}:${TOKEN}`, 6n);
    await syncRouter(c);
    c.reorg(107n, 112n, [owedLog(109n, 4, hex(6), 6n)]);
    await syncRouter(c);
    expect((await db.query<{ amount: string }>(`SELECT amount FROM owed`))[0]!.amount).toBe("6");
    expect((await db.query(`SELECT 1 FROM owed_logs`)).length).toBe(1);
  });

  // Needs real Postgres: the stand-in returns BIGINT columns with a different type, which this test compares exactly.
  test.skipIf(!process.env.TEST_DATABASE_URL)("an exit that moves keeps one record, at its new block, with its payout once", async () => {
    await r.recordExit({ exitId: 1n, posId: P, owner: OWNER, caller: OWNER, alarmKey: K, viaAlarm: true, tx: hex(6), block: 108n });
    await r.recordPayout({ exitId: 1n, tx: hex(6), logIndex: 1, token: TOKEN, amount: 5n, swapped: false, block: 108n });
    await r.undoRouter(107n);
    expect((await db.query(`SELECT 1 FROM exits`)).length + (await db.query(`SELECT 1 FROM exit_payouts`)).length).toBe(0);
    await r.recordExit({ exitId: 1n, posId: P, owner: OWNER, caller: OWNER, alarmKey: K, viaAlarm: true, tx: hex(6), block: 109n });
    await r.recordExit({ exitId: 1n, posId: P, owner: OWNER, caller: OWNER, alarmKey: K, viaAlarm: true, tx: hex(6), block: 110n });
    expect((await db.query<{ block: string }>(`SELECT block FROM exits`)).map((x) => x.block)).toEqual(["110"]);
  });
});

describe("plan payments are credited exactly once", () => {
  const syncPayments = (c: MockChain) =>
    syncLogs(c.client, r, {
      name: "payments", address: VAULT, startBlock: 90n, confirmations: 3n, now: () => 1_000_000,
      onLog: async (l) => void (await applyPayment(r, l, 1_000_000)),
      onRewind: async (from) => void (await r.bump("payments_reorged_after_credit", await r.undoPayments(from))),
    });
  const paid = () => r.paidUntil(OWNER.toLowerCase());
  const rows = async () => (await db.query(`SELECT 1 FROM plan_payments`)).length;

  test("a payment that moves to another block and log index is not credited again", async () => {
    const c = new MockChain(105n);
    c.logs = [paymentLog(100n, 2, hex(0x50))];
    await syncPayments(c);
    const once = 1_000_000 + 90 * 86_400;
    expect(await paid()).toBe(once);
    c.reorg(99n, 120n, [paymentLog(102n, 7, hex(0x50))]);
    await syncPayments(c);
    expect(await syncPayments(c)).toBe(117n);
    expect(await paid()).toBe(once);
    expect(await rows()).toBe(1);
    expect(await counter("payments_reorged_after_credit")).toBe("1");
    expect(await counter("reorgs_handled")).toBe("1");
  });

  test("a payment that comes back at the same place is not credited again", async () => {
    const c = new MockChain(105n);
    c.logs = [paymentLog(100n, 2, hex(0x50))];
    await syncPayments(c);
    c.reorg(99n, 120n, [paymentLog(100n, 2, hex(0x50))]);
    await syncPayments(c);
    expect(await paid()).toBe(1_000_000 + 90 * 86_400);
    expect(await rows()).toBe(1);
  });

  test("a payment that is gone for good keeps its credit, which is counted for the operators, and a later payment still credits", async () => {
    const c = new MockChain(105n);
    c.logs = [paymentLog(100n, 2, hex(0x50))];
    await syncPayments(c);
    c.reorg(99n, 120n, []);
    await syncPayments(c);
    expect(await paid()).toBe(1_000_000 + 90 * 86_400);
    expect(await counter("payments_reorged_after_credit")).toBe("1");
    c.reorg(121n, 130n, [paymentLog(125n, 0, hex(0x51))]);
    await syncPayments(c);
    expect(await rows()).toBe(2);
  });

  test("a payment that was not yet applied when it was dropped is forgotten", async () => {
    await r.recordPayment({ tx: hex(0x60), logIndex: 1, wallet: OWNER.toLowerCase(), amount: 15_000_000n, credited: true, at: 1, block: 100n });
    await r.undoPayments(100n);
    expect(await rows()).toBe(0);
  });
});

describe("a reorg deeper than the window", () => {
  test("is reported to the operators, and the cursor rewinds to the start of the window", async () => {
    const window = 10n;
    const c = new MockChain(90n);
    const alerts: ReorgInfo[] = [];
    const opts = {
      window,
      onLog: async () => {},
      onDeepReorg: async (i: ReorgInfo) => {
        alerts.push(i);
        await queueOps(r, `reorg:${i.source}:${i.cursor}:${i.rewoundTo}`, deepReorgText(i), 1_000);
      },
    };
    for (const head of [90n, 94n, 98n, 100n]) {
      c.head = head;
      await syncLogs(c.client, r, { name: "x", address: ROUTER, startBlock: 50n, ...opts });
    }
    expect(await r.cursor("x")).toBe(101n);
    expect((await r.storedHashes("x", 101n)).map((h) => h.block)).toEqual([94n, 98n, 100n]); // older ones are pruned
    // Everything remembered is on the old fork.
    c.reorg(60n, 102n);
    c.asked = [];
    await syncLogs(c.client, r, { name: "x", address: ROUTER, startBlock: 50n, ...opts });
    expect(alerts).toEqual([{ source: "x", cursor: 101n, rewoundTo: 91n, beyondWindow: true }]);
    expect(c.asked[0]![0]).toBe(91n);
    expect(await r.cursor("x")).toBe(103n);
    expect(await counter("reorgs_handled")).toBe("1");
    const ops = await r.dueJobs("ops", 1_000);
    expect(ops).toHaveLength(1);
    const text = (ops[0]!.payload as { text: string }).text;
    expect(text).toContain("deeper than the blocks it remembers");
    expect(text).not.toMatch(/https?:/);
    // The old hashes are gone, so the next pass doesn't rewind again.
    await syncLogs(c.client, r, { name: "x", address: ROUTER, startBlock: 50n, ...opts });
    expect(await counter("reorgs_handled")).toBe("1");
  });

  test("a reorg inside the window is not reported", async () => {
    const alerts: ReorgInfo[] = [];
    const c = new MockChain(100n);
    const opts = { window: 50n, onLog: async () => {}, onDeepReorg: async (i: ReorgInfo) => void alerts.push(i) };
    for (const head of [90n, 94n, 98n, 100n]) {
      c.head = head;
      await syncLogs(c.client, r, { name: "x", address: ROUTER, startBlock: 50n, ...opts });
    }
    c.reorg(97n, 102n);
    await syncLogs(c.client, r, { name: "x", address: ROUTER, startBlock: 50n, ...opts });
    expect(alerts).toEqual([]);
    expect(await r.cursor("x")).toBe(103n);
    expect(await counter("reorgs_handled")).toBe("1");
  });

  test("the default window is 2,000 blocks, and old hashes are pruned past it", async () => {
    expect(REORG_WINDOW).toBe(2_000n);
    const c = new MockChain(5_000n);
    await syncLogs(c.client, r, { name: "x", address: ROUTER, startBlock: 0n, step: 100n, onLog: async () => {} });
    const kept = (await r.storedHashes("x", 5_001n)).map((h) => h.block);
    expect(kept.every((b) => b >= 3_001n)).toBe(true);
    expect(kept).toContain(5_000n);
  });
});

describe("logs parked from dropped blocks", () => {
  test("are dropped with them rather than retried", async () => {
    const c = new MockChain(110n);
    c.logs = [owedLog(108n, 0, hex(6), 6n)];
    await syncRouter(c, { onLog: async () => { throw new Error("bad"); } });
    expect((await r.parkedLogs("router")).length).toBe(1);
    c.reorg(107n, 112n);
    await syncRouter(c);
    expect(await r.parkedLogs("router")).toEqual([]);
  });
});
