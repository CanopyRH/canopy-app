import { maxUint256, type Address, type Hex } from "viem";
import { keyOf, type Detector, type Preset } from "../../services/src/api/presets";
import { notArmable, refusedPresets, type AlarmIo } from "./alarms";
import { COPY } from "./copy/text";
import { BATCH_COPY } from "./copy/batch";
import { approveTx, armTx, type Tx } from "./tx";
import { type Payout } from "./stableExit";
import { ensureChain, type Eip1193, type Network } from "./wallet";

/**
 * One-step arming (EIP-5792). The same approve and arm transactions as the step-by-step flow, in the same order, sent as one
 * batch when the wallet can run them together and nothing needs registering first. Nothing here decides what to send: the arm-time safety check and the
 * transaction builders are the same ones the step-by-step flow uses.
 */

/** The arm-time check. No tripped, recently fired or unreadable key, and every key one of this vault's own presets. Throws before anything is sent. */
export async function assertArmable(io: AlarmIo, presets: Preset[], keys: Hex[]): Promise<void> {
  if (keys.some((k) => !presets.some((p) => p.key === k)) || (await refusedPresets(io, presets, keys)).length > 0) throw new Error(COPY.armRefused);
}

/** Whether a detector is one of the chosen presets, or a part one of them depends on. */
export function needed(presets: Preset[], keys: Hex[], d: Detector): boolean {
  const key = keyOf(d);
  return presets.filter((p) => keys.includes(p.key)).some((p) => p.key === key || (p.requires ?? []).some((r) => r.key === key));
}

/** Every key the chosen presets arm: each chosen key and the parts of a combined alarm. The router asks armable() about the keys it arms, so the app asks about the parts too. */
export const askedKeys = (presets: Preset[], keys: Hex[]): Hex[] =>
  [...new Set(presets.filter((p) => keys.includes(p.key)).flatMap((p) => [p.key, ...(p.requires ?? []).map((q) => q.key)]))];

/**
 * How many wallet confirmations arming will take. One when the wallet can batch and armPlan() would batch: nothing to
 * register and an approval to send with the arm. Otherwise one per unregistered alarm part, one for the approval if it is
 * needed, and one for the arm, which is what arm()'s steps send.
 */
export function confirmCount(o: { batch: boolean; unregistered: number; needsApproval: boolean }): number {
  if (o.batch && o.unregistered === 0 && o.needsApproval) return 1;
  return o.unregistered + (o.needsApproval ? 1 : 0) + 1;
}

export interface PlanDeps {
  io: AlarmIo;
  book: Address;
  router: Address;
  adapter: Address;
  /** Owner-reviewed payout, shared with the stepwise flow. Defaults to raw. */
  payout?: Payout;
  /** This vault's presets and the detectors they need, dependencies first, worked out the same way the step-by-step flow does (the Paused alarm only where the vault answers paused()). */
  presets: Preset[];
  order: Detector[];
  /** AlarmBook.state(key).exists */
  isRegistered: (key: Hex) => Promise<boolean>;
  /** AlarmBook.armable(key): the contract's own answer. Only meaningful for registered keys. */
  armable: (key: Hex) => Promise<boolean>;
  /** The vault shares the router may already spend for this owner. */
  allowance: () => Promise<bigint>;
}

/**
 * The batch for a one-confirmation arm, or null when the step-by-step flow must be used. AlarmBook.armable() says no to a key
 * that was never registered, so a key that needs registering cannot be checked before it is, and a register inside the same
 * batch would be sent before anyone could look. So a batch is only built when every needed key is already registered and the
 * contract calls every key and every part of a combined alarm armable. Then it is the approval (if needed) and the arm call,
 * with the same arm tuple as the step-by-step flow (including the owner-reviewed payout, defaulting to raw). A key the contract refuses throws here,
 * before the wallet is asked, as it would in the step-by-step flow after registration.
 */
export async function armPlan(d: PlanDeps, vault: Address, keys: Hex[]): Promise<Tx[] | null> {
  await assertArmable(d.io, d.presets, keys);
  const wanted = d.order.filter((x) => needed(d.presets, keys, x));
  const known = await Promise.all(wanted.map((x) => d.isRegistered(keyOf(x)).catch(() => false)));
  if (known.some((k) => !k)) return null;
  if ((await notArmable(d.armable, askedKeys(d.presets, keys))).length > 0) throw new Error(COPY.armRefused);
  const txs: Tx[] = [];
  if ((await d.allowance()) < maxUint256 / 2n) txs.push(approveTx(vault, d.router));
  txs.push(armTx(d.router, d.adapter, vault, keys, d.payout));
  return txs;
}

// ---- Capabilities ----

/** atomic: the current spec's name. atomicBatch: the older draft's. */
export type BatchKind = "atomic" | "atomicBatch";

type Caps = Record<string, { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } } | undefined>;

/**
 * Whether the wallet can run a batch all-or-nothing on this chain. `atomic` counts when its status is supported, or
 * ready (the wallet upgrades the account with the user's approval). Any error means no.
 */
export async function batchSupport(w: Eip1193, account: Address, chainHex: string): Promise<BatchKind | null> {
  try {
    const all = (await w.request({ method: "wallet_getCapabilities", params: [account, [chainHex]] })) as Caps | null;
    if (!all || typeof all !== "object") return null;
    const key = Object.keys(all).find((k) => k.toLowerCase() === chainHex.toLowerCase());
    // "0x0" holds what a wallet supports on every chain. The chain's own entry wins.
    const caps = { ...all["0x0"], ...(key ? all[key] : undefined) };
    const status = caps.atomic?.status;
    if (status === "supported" || status === "ready") return "atomic";
    if (caps.atomicBatch?.supported === true) return "atomicBatch";
    return null;
  } catch {
    return null;
  }
}

// ---- Sending ----

/** Codes and wording that mean "this wallet can't do that", not "the user said no". Nothing was sent in either case. */
export function suggestsNoSupport(e: unknown): boolean {
  const err = e as { code?: number; message?: string };
  if (err?.code === 4001) return false; // The user declined. Asking three more times would be wrong.
  if (err?.code !== undefined && [-32601, -32602, 4200, 5700, 5710, 5740, 5750, 5760].includes(err.code)) return true;
  return /method (not found|not supported|does not exist)|not (supported|implemented)|unsupported|unknown method/i.test(err?.message ?? "");
}

export interface BatchCall { to: Address; data: Hex; value: Hex }

export const toCalls = (txs: Tx[]): BatchCall[] => txs.map((t) => ({ to: t.to, data: t.data, value: "0x0" }));

/** Sends the batch and returns its id. A wallet on the older draft gets the older request shape. */
export async function sendBatch(w: Eip1193, from: Address, txs: Tx[], kind: BatchKind, chainHex: string): Promise<string> {
  const params = kind === "atomic"
    ? { version: "2.0.0", from, chainId: chainHex, atomicRequired: true, calls: toCalls(txs) }
    : { version: "1.0", from, chainId: chainHex, calls: toCalls(txs) };
  const r = (await w.request({ method: "wallet_sendCalls", params: [params] })) as string | { id?: string } | null;
  const id = typeof r === "string" ? r : r?.id;
  if (!id) throw new Error(COPY.txFailed);
  return id;
}

// ---- Tracking ----

export type BatchOutcome = "success" | "failed" | "partial" | "unknown";

const reverted = (r: unknown) => {
  const s = (r as { status?: unknown } | null)?.status;
  return s === "0x0" || s === "0x00" || s === 0 || s === "reverted" || s === "failure";
};

/** One status reading as pending or an outcome. Anything not clearly a full success is never reported as one. */
export function readStatus(s: { status?: unknown; receipts?: unknown } | null): BatchOutcome | "pending" {
  if (!s) return "pending";
  const receipts = Array.isArray(s.receipts) ? s.receipts : s.receipts ? [s.receipts] : [];
  const bad = receipts.filter(reverted).length;
  const confirmed = () => (bad === 0 ? "success" : bad === receipts.length ? "failed" : "partial");
  if (typeof s.status === "string") {
    return s.status === "CONFIRMED" ? confirmed() : "pending"; // CONFIRMED is the older draft's word.
  }
  if (typeof s.status !== "number") return "pending";
  const n = s.status;
  if (n >= 100 && n < 200) return "pending";
  if (n >= 200 && n < 300) return confirmed(); // A 200 with a reverted receipt is not a success.
  if (n >= 400 && n < 600) return "failed";
  return "partial"; // 600 and any wallet-specific 7xx or above: something may have landed.
}

export interface WaitOptions { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> }

/** Polls wallet_getCallsStatus until the batch settles. Read errors count as pending until time runs out. */
export async function waitForBatch(w: Eip1193, id: string, o: WaitOptions = {}): Promise<BatchOutcome> {
  const interval = o.intervalMs ?? 1_500;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tries = Math.ceil((o.timeoutMs ?? 180_000) / interval);
  for (let i = 0; i < tries; i++) {
    const s = await w.request({ method: "wallet_getCallsStatus", params: [id] }).then((x) => x as { status?: unknown; receipts?: unknown } | null, () => null);
    const out = readStatus(s);
    if (out !== "pending") return out;
    await sleep(interval);
  }
  return "unknown";
}

export function outcomeError(o: Exclude<BatchOutcome, "success">): Error {
  return new Error(o === "failed" ? BATCH_COPY.batchFailed : o === "partial" ? BATCH_COPY.batchPartial : BATCH_COPY.batchUnknown);
}

export interface BatchEnv { provider: Eip1193; account: Address; network: Network; onConfirm: () => void; wait?: WaitOptions }

/**
 * Sends the plan as one batch and waits for it. Returns "fallback" only when the wallet refused the request itself,
 * which means nothing was sent. After the request is accepted, a problem is reported and never retried.
 */
export async function runBatch(env: BatchEnv, txs: Tx[], kind: BatchKind): Promise<"done" | "fallback"> {
  await ensureChain(env.provider, env.network);
  env.onConfirm();
  let id: string;
  try {
    id = await sendBatch(env.provider, env.account, txs, kind, env.network.chainHex);
  } catch (e) {
    if (suggestsNoSupport(e)) return "fallback";
    throw e;
  }
  const out = await waitForBatch(env.provider, id, env.wait);
  if (out !== "success") throw outcomeError(out);
  return "done";
}

export interface ArmEnv extends BatchEnv {
  plan: PlanDeps;
  /** Today's step-by-step flow, unchanged. */
  stepwise: () => Promise<void>;
}

/**
 * Arms with one wallet confirmation when the wallet can batch and every key is already registered and armable, and step by
 * step otherwise. The alarm re-check runs first, before the wallet is asked anything. A lone arm call has nothing to batch,
 * so it goes the usual way.
 */
export async function armOneStep(env: ArmEnv, vault: Address, keys: Hex[]): Promise<"batch" | "steps"> {
  await assertArmable(env.plan.io, env.plan.presets, keys);
  const kind = await batchSupport(env.provider, env.account, env.network.chainHex);
  if (!kind) return (await env.stepwise(), "steps");
  const txs = await armPlan(env.plan, vault, keys);
  if (!txs || txs.length < 2) return (await env.stepwise(), "steps");
  if ((await runBatch(env, txs, kind)) === "fallback") return (await env.stepwise(), "steps");
  return "batch";
}
