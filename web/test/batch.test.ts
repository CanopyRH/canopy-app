import { describe, expect, test } from "bun:test";
import { maxUint256, type Address, type Hex } from "viem";
import { armOneStep, armPlan, batchSupport, readStatus, sendBatch, suggestsNoSupport, toCalls, waitForBatch, type ArmEnv, type PlanDeps } from "../src/batch";
import { REFIRE_SECONDS, type AlarmIo } from "../src/alarms";
import { COPY } from "../src/copy/text";
import { BATCH_COPY } from "../src/copy/batch";
import { approveTx, armTx, registerTx, type Tx } from "../src/tx";
import { keyOf, presetsFor, registrationOrder } from "../../services/src/api/presets";
import type { Eip1193 } from "../src/wallet";

const V = "0x00000000000000000000000000000000000000a3" as Address;
const BOOK = "0x00000000000000000000000000000000000000a1" as Address;
const ROUTER = "0x00000000000000000000000000000000000000a4" as Address;
const ADAPTER = "0x00000000000000000000000000000000000000a5" as Address;
const ME = "0x00000000000000000000000000000000000000a6" as Address;
const NOW = 2_000_000_000n;
const NET = { chainHex: "0x1237", chainName: "Robinhood Chain", rpcUrl: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com" };
const presets = presetsFor(V);
const byName = (n: string) => presets.find((p) => p.name === n)!;
const KEYS = [byName("Vault loss").key, byName("Exploit confirmed").key];

const clear = (tripped: Hex[] = [], fired: Record<Hex, bigint> = {}): AlarmIo => ({
  check: async (k) => tripped.includes(k),
  firedAt: async (k) => fired[k] ?? 0n,
  now: async () => NOW,
});
const deps = (o: Partial<PlanDeps> = {}): PlanDeps => ({ io: clear(), book: BOOK, router: ROUTER, adapter: ADAPTER, isRegistered: async () => false, allowance: async () => 0n, ...o });

/** A mock EIP-1193 wallet that records every request. `handlers` answer by method; anything else is an error. */
function mock(handlers: Record<string, (params?: unknown[]) => unknown>) {
  const calls: { method: string; params?: unknown[] }[] = [];
  const p: Eip1193 = {
    request: async (a) => {
      calls.push(a);
      if (a.method === "eth_chainId") return "0x1237";
      const h = handlers[a.method];
      if (!h) throw Object.assign(new Error("method not found"), { code: -32601 });
      return h(a.params);
    },
  };
  return { p, calls, methods: () => calls.map((c) => c.method) };
}
const caps = (c: unknown) => ({ wallet_getCapabilities: () => c });
const err = (code: number, message = "x") => Object.assign(new Error(message), { code });

/** What today's step-by-step flow sends, worked out separately from armPlan. */
function expectedStepwise(registered: Hex[], allowance: bigint): Tx[] {
  const wanted = new Set(KEYS.flatMap((k) => { const p = presets.find((x) => x.key === k)!; return [p.key, ...(p.requires ?? []).map((r) => r.key)]; }));
  const txs = registrationOrder(V).filter((d) => wanted.has(keyOf(d)) && !registered.includes(keyOf(d))).map((d) => registerTx(BOOK, d));
  if (allowance < maxUint256 / 2n) txs.push(approveTx(V, ROUTER));
  return [...txs, armTx(ROUTER, ADAPTER, V, KEYS)];
}

describe("capability detection", () => {
  test("asks for this account on chain 0x1237", async () => {
    const w = mock(caps({ "0x1237": { atomic: { status: "supported" } } }));
    expect(await batchSupport(w.p, ME, "0x1237")).toBe("atomic");
    expect(w.calls[0]).toEqual({ method: "wallet_getCapabilities", params: [ME, ["0x1237"]] });
  });
  test("atomic supported and atomic ready both count; unsupported does not", async () => {
    for (const [status, want] of [["supported", "atomic"], ["ready", "atomic"], ["unsupported", null]] as const) {
      expect(await batchSupport(mock(caps({ "0x1237": { atomic: { status } } })).p, ME, "0x1237")).toBe(want);
    }
  });
  test("the older atomicBatch name counts", async () => {
    expect(await batchSupport(mock(caps({ "0x1237": { atomicBatch: { supported: true } } })).p, ME, "0x1237")).toBe("atomicBatch");
    expect(await batchSupport(mock(caps({ "0x1237": { atomicBatch: { supported: false } } })).p, ME, "0x1237")).toBeNull();
  });
  test("a wallet listing support for every chain under 0x0 counts, and the chain's own entry wins", async () => {
    expect(await batchSupport(mock(caps({ "0x0": { atomic: { status: "supported" } } })).p, ME, "0x1237")).toBe("atomic");
    expect(await batchSupport(mock(caps({ "0x0": { atomic: { status: "supported" } }, "0x1237": { atomic: { status: "unsupported" } } })).p, ME, "0x1237")).toBeNull();
  });
  test("support on another chain only is no support", async () => {
    expect(await batchSupport(mock(caps({ "0x1": { atomic: { status: "supported" } } })).p, ME, "0x1237")).toBeNull();
  });
  test("a wallet without the method, or one that errors or answers oddly, is no support", async () => {
    expect(await batchSupport(mock({}).p, ME, "0x1237")).toBeNull();
    expect(await batchSupport(mock({ wallet_getCapabilities: () => { throw err(4100); } }).p, ME, "0x1237")).toBeNull();
    expect(await batchSupport(mock(caps(null)).p, ME, "0x1237")).toBeNull();
    expect(await batchSupport(mock(caps("yes")).p, ME, "0x1237")).toBeNull();
  });
});

describe("the batch matches the step-by-step flow", () => {
  test("register (dependencies first), approve, then arm, with the same calldata", async () => {
    const txs = await armPlan(deps(), V, KEYS);
    expect(txs.length).toBeGreaterThanOrEqual(3);
    expect(txs).toEqual(expectedStepwise([], 0n));
    expect(txs.at(-1)!.to).toBe(ROUTER);
    expect(txs.at(-2)!).toEqual(approveTx(V, ROUTER));
    expect(txs.slice(0, -2).every((t) => t.to === BOOK)).toBe(true);
  });
  test("a combined alarm registers its parts before itself", async () => {
    const both = byName("Vault drain + confirmation");
    const txs = await armPlan(deps(), V, [both.key]);
    const order = registrationOrder(V).filter((d) => [both.key, ...both.requires!.map((r) => r.key)].includes(keyOf(d)));
    expect(order.map(keyOf).at(-1)).toBe(both.key);
    expect(txs).toEqual([...order.map((d) => registerTx(BOOK, d)), approveTx(V, ROUTER), armTx(ROUTER, ADAPTER, V, [both.key])]);
  });
  test("skips alarms already registered and an approval already given", async () => {
    const some = registrationOrder(V).map(keyOf).slice(0, 1);
    expect(await armPlan(deps({ isRegistered: async (k) => some.includes(k) }), V, KEYS)).toEqual(expectedStepwise(some, 0n));
    const txs = await armPlan(deps({ isRegistered: async () => true, allowance: async () => maxUint256 }), V, KEYS);
    expect(txs).toEqual([armTx(ROUTER, ADAPTER, V, KEYS)]);
  });
  test("the request carries those calls in order, to the same targets", async () => {
    const txs = await armPlan(deps(), V, KEYS);
    const w = mock({ wallet_sendCalls: () => ({ id: "0x01" }) });
    expect(await sendBatch(w.p, ME, txs, "atomic", "0x1237")).toBe("0x01");
    const sent = (w.calls[0]!.params![0] as { calls: { to: Address; data: Hex }[]; atomicRequired: boolean; version: string; chainId: string; from: Address });
    expect(sent.calls.map((c) => [c.to, c.data])).toEqual(txs.map((t) => [t.to, t.data]));
    expect(sent).toMatchObject({ version: "2.0.0", chainId: "0x1237", from: ME, atomicRequired: true });
    expect(toCalls(txs).every((c) => c.value === "0x0")).toBe(true);
  });
  test("the older draft gets its own request shape, and a plain string id is understood", async () => {
    const w = mock({ wallet_sendCalls: () => "0xabc" });
    expect(await sendBatch(w.p, ME, await armPlan(deps(), V, KEYS), "atomicBatch", "0x1237")).toBe("0xabc");
    const sent = w.calls[0]!.params![0] as Record<string, unknown>;
    expect(sent.version).toBe("1.0");
    expect("atomicRequired" in sent).toBe(false);
  });
});

describe("status polling", () => {
  const fast = { intervalMs: 1, timeoutMs: 5, sleep: async () => {} };
  const seq = (...answers: unknown[]) => {
    let i = 0;
    return mock({ wallet_getCallsStatus: () => { const a = answers[Math.min(i++, answers.length - 1)]; if (a instanceof Error) throw a; return a; } });
  };
  test("pending, then success", async () => {
    const w = seq({ status: 100 }, { status: 100 }, { status: 200, receipts: [{ status: "0x1" }] });
    expect(await waitForBatch(w.p, "0x01", fast)).toBe("success");
    expect(w.calls.map((c) => c.params![0])).toEqual(["0x01", "0x01", "0x01"]);
  });
  test("the older draft's CONFIRMED works too", async () => {
    expect(await waitForBatch(seq({ status: "PENDING" }, { status: "CONFIRMED", receipts: [{ status: "0x1" }] }).p, "0x01", fast)).toBe("success");
  });
  test("400 and 500 are failures", async () => {
    expect(await waitForBatch(seq({ status: 400 }).p, "0x01", fast)).toBe("failed");
    expect(await waitForBatch(seq({ status: 500, receipts: [{ status: "0x0" }] }).p, "0x01", fast)).toBe("failed");
  });
  test("600 is partial", async () => {
    expect(await waitForBatch(seq({ status: 600, receipts: [{ status: "0x1" }, { status: "0x0" }] }).p, "0x01", fast)).toBe("partial");
  });
  test("a 200 with a reverted receipt is never a success", () => {
    expect(readStatus({ status: 200, receipts: [{ status: "0x1" }, { status: "0x0" }] })).toBe("partial");
    expect(readStatus({ status: 200, receipts: [{ status: "0x0" }] })).toBe("failed");
    expect(readStatus({ status: "CONFIRMED", receipts: [{ status: "0x1" }, { status: "0x0" }] })).toBe("partial");
  });
  test("an unknown code is not a success", () => {
    expect(readStatus({ status: 700 })).toBe("partial");
    expect(readStatus({ status: "WHO KNOWS" })).toBe("pending");
  });
  test("read errors count as pending, and a batch that never settles ends as unknown", async () => {
    expect(await waitForBatch(seq(err(5730), { status: 200 }).p, "0x01", fast)).toBe("success");
    expect(await waitForBatch(seq({ status: 100 }).p, "0x01", fast)).toBe("unknown");
  });
});

describe("arming through the wallet", () => {
  /** Builds an environment around a mock wallet; `steps` counts calls to today's flow. */
  function env(handlers: Record<string, (p?: unknown[]) => unknown>, plan: Partial<PlanDeps> = {}) {
    const w = mock(handlers);
    const log = { steps: 0, confirms: 0 };
    const e: ArmEnv = {
      provider: w.p, account: ME, network: NET, onConfirm: () => void log.confirms++,
      wait: { intervalMs: 1, timeoutMs: 3, sleep: async () => {} },
      plan: deps(plan),
      stepwise: async () => void log.steps++,
    };
    return { e, w, log };
  }
  const ok = { ...caps({ "0x1237": { atomic: { status: "supported" } } }), wallet_sendCalls: () => ({ id: "0x01" }), wallet_getCallsStatus: () => ({ status: 200, receipts: [{ status: "0x1" }] }) };

  test("a wallet that batches arms with one request and never uses the step-by-step flow", async () => {
    const { e, w, log } = env(ok);
    expect(await armOneStep(e, V, KEYS)).toBe("batch");
    expect(log).toEqual({ steps: 0, confirms: 1 });
    expect(w.methods().filter((m) => m === "wallet_sendCalls")).toHaveLength(1);
    expect(w.methods()).not.toContain("eth_sendTransaction");
  });
  test("a wallet without the capability falls back to the step-by-step flow, and no batch is sent", async () => {
    const { e, w, log } = env({});
    expect(await armOneStep(e, V, KEYS)).toBe("steps");
    expect(log.steps).toBe(1);
    expect(w.methods()).not.toContain("wallet_sendCalls");
  });
  test("a wallet that claims support but refuses the request as unsupported falls back, once", async () => {
    for (const refuse of [err(5760), err(5710), err(-32601), err(4200), err(-32000, "wallet_sendCalls is not supported")]) {
      const { e, log } = env({ ...ok, wallet_sendCalls: () => { throw refuse; } });
      expect(await armOneStep(e, V, KEYS)).toBe("steps");
      expect(log.steps).toBe(1);
    }
  });
  test("the user declining the batch is not a reason to ask three more times", async () => {
    const { e, log } = env({ ...ok, wallet_sendCalls: () => { throw err(4001, "User rejected the request"); } });
    await expect(armOneStep(e, V, KEYS)).rejects.toMatchObject({ code: 4001 });
    expect(log.steps).toBe(0);
    expect(suggestsNoSupport(err(4001, "not supported"))).toBe(false);
  });
  test("a batch that fails after it was accepted is reported and never retried step by step", async () => {
    for (const [status, text] of [[500, BATCH_COPY.batchFailed], [600, BATCH_COPY.batchPartial]] as const) {
      const { e, log, w } = env({ ...ok, wallet_getCallsStatus: () => ({ status }) });
      await expect(armOneStep(e, V, KEYS)).rejects.toThrow(text);
      expect(log.steps).toBe(0);
      expect(w.methods().filter((m) => m === "wallet_sendCalls")).toHaveLength(1);
    }
    const { e, log } = env({ ...ok, wallet_getCallsStatus: () => ({ status: 100 }) });
    await expect(armOneStep(e, V, KEYS)).rejects.toThrow(BATCH_COPY.batchUnknown);
    expect(log.steps).toBe(0);
  });
  test("with only the arm call left to send, there is nothing to batch", async () => {
    const { e, w, log } = env(ok, { isRegistered: async () => true, allowance: async () => maxUint256 });
    expect(await armOneStep(e, V, KEYS)).toBe("steps");
    expect(log.steps).toBe(1);
    expect(w.methods()).not.toContain("wallet_sendCalls");
  });
});

describe("the safety re-check comes before any wallet request", () => {
  const ok = { ...caps({ "0x1237": { atomic: { status: "supported" } } }), wallet_sendCalls: () => ({ id: "0x01" }) };
  async function refused(io: AlarmIo, keys: Hex[] = KEYS) {
    const w = mock(ok);
    let steps = 0;
    const e: ArmEnv = { provider: w.p, account: ME, network: NET, onConfirm: () => {}, plan: deps({ io }), stepwise: async () => void steps++ };
    await expect(armOneStep(e, V, keys)).rejects.toThrow(COPY.armRefused);
    expect(w.calls).toEqual([]); // Not even a capabilities or chain request.
    expect(steps).toBe(0);
  }
  test("a tripped key", () => refused(clear([KEYS[0]!])));
  test("a key that fired in the last day", () => refused(clear([], { [KEYS[0]!]: NOW - REFIRE_SECONDS + 10n })));
  test("an unreadable key", () => refused({ ...clear(), check: async () => { throw new Error("rpc down"); } }));
  test("a tripped part that a chosen alarm depends on", () => {
    const both = byName("Vault drain + confirmation");
    return refused(clear([both.requires![0]!.key]), [both.key]);
  });
  test("a key that is not one of this vault's own presets", () => refused(clear(), [`0x${"11".repeat(32)}` as Hex]));
  test("armPlan alone refuses too, so no caller can build a batch around a tripped key", async () => {
    await expect(armPlan(deps({ io: clear([KEYS[0]!]) }), V, KEYS)).rejects.toThrow(COPY.armRefused);
  });
});
