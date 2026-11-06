import { decodeFunctionResult, encodeFunctionData, getAbiItem, toEventSelector, type Address, type Hex, type PublicClient } from "viem";
import { alarmBookAbi, erc20Abi, multicall3Abi, positionManagerAbi, routerAbi, vaultAbi } from "../chain/abi";
import { isOwnKey } from "../api/levels";
import { isPreset, Kind } from "../api/presets";
import { keeperShouldRun } from "../billing/prepaid";
import type { Repo } from "../store/repo";
import { deallocateCalls, type PlainCall } from "./liquidity";
import type { Fees } from "./sender";
import { judge, sizeExit } from "./simulate";

export const ALARM_TTL = 86_400;
export const RETRY_SEC = 30;
/** Stays well under the 16.7M gas that a single transaction may use, once the margin is added. */
export const BUNDLE_GAS = 10_000_000n;
/**
 * Keys per shared check request. AlarmBook v2 gives every read of a detector's target a full TARGET_READ_GAS (1M) and reverts
 * with NotEnoughGas when less than about 1.03M is left, so a check can cost up to two reads. Twenty keys of ordinary vaults
 * (about 250k a read at worst) use a few million gas, which fits a node's cap with room to spare.
 */
export const CHECKS_PER_CALL = 20;
/**
 * The gas every shared check request is sent with. Without one a node uses its own cap, and what a request can do then
 * depends on that cap. Overridable (KEEPER_CHECK_GAS) for a node that refuses this much.
 */
export const CHECK_CALL_GAS = 30_000_000n;
/** The gas a key checked on its own is sent with: two full reads and room for the 1/64 rule. */
export const CHECK_ALONE_GAS = 5_000_000n;
/** AlarmBook.DRAIN_CONFIRM: a DRAIN poke that saw the drop fires only once a second poke comes this long after it. */
export const DRAIN_CONFIRM_SEC = 60;
/**
 * The least gas any transaction that reads a detector's target (a poke, a checkpoint) is sent with. AlarmBook reverts
 * NotEnoughGas unless about 1.03M is still left at each read, and a SHARE_DROP reads twice. A limit taken from a simulation
 * alone (the gas the reads actually used, often 200k) would sit far below that and make every such transaction revert.
 * Gas that isn't used isn't charged.
 */
export const READ_GAS_FLOOR = 1_600_000n;
/** Extra gas on an exit's limit, beyond the simulation's margin: an owner's swap leg quotes under a 500k cap and skips if it can't get it. */
export const EXIT_SWAP_HEADROOM = 600_000n;
/** How long one exit, or one vault's bundle, may run before the keeper moves on. Contracts anyone can write answer its reads. */
export const JOB_BUDGET_MS = 45_000;
/** A job that ran out of time waits this long, so it can't take the budget on every pass. */
export const SLOW_RETRY_SEC = 300;
/** No new job starts once a pass has run this long. The rest stay due for the next pass, which fetches listed vaults' jobs first. */
export const PASS_BUDGET_MS = 90_000;
/** How long a key whose own check fails stays out of the shared check. */
export const QUARANTINE_SEC = 600;
const QUARANTINE = new Map<string, number>();
/** Comfortably under the 2^24 gas a single transaction may use. A listed vault's exit that needs more can't be sent. */
export const MAX_TX_GAS = 16_000_000n;
/**
 * The most gas an exit from a vault Canopy doesn't list may use. Honest ERC-4626 redeems cost well under 1M even across
 * many markets; anything far beyond that is a contract spending the keeper's gas. KEEPER_UNLISTED_EXIT_GAS overrides it.
 */
export const UNLISTED_EXIT_GAS = 4_000_000n;
/** The most an owed claim or quorum fire may use. */
export const SMALL_CALL_GAS = 1_000_000n;
/**
 * The most a poke or checkpoint may use. Each reads its target (up to twice for SHARE_DROP) and AlarmBook hands every read
 * 1M gas, so one that costs a little over 1M in simulation is ordinary. Never below READ_GAS_FLOOR, or the cap and the floor disagree.
 */
export const POKE_CALL_GAS = 3_000_000n;
/** The most an exit for a position with owner swap legs may use. A leg quotes under a 500k cap, and the exit runs alone. */
export const SWAP_EXIT_GAS = 8_000_000n;
/** Open exit jobs one owner may have in the queue at once. The rest wait until earlier ones end. */
export const MAX_OPEN_EXITS_PER_OWNER = 32;
/** An unlisted exit refused for gas, or sent without moving the owner's balance, backs off and ends after this many strikes. */
export const MAX_STRIKES = 5;
/** Checkpoints per pass beyond the listed vaults' own presets, taken least recently sent first. */
export const MAX_CHECKPOINTS_PER_PASS = 20;
/** Owed claims sent per pass. */
export const MAX_OWED_PER_PASS = 20;
const CHECKPOINTED = new Map<string, number>();

/** A call with the gas limit it is sent under. Every keeper transaction has one, derived from a simulation. */
export type GasCall = PlainCall & { gas: bigint };

/** The limit for a call that used `used` gas in simulation: room for a vault that costs more by the time it lands. */
export const limitFromSim = (used: bigint) => (used * 3n) / 2n + 100_000n;
const least = (a: bigint, b: bigint) => (a < b ? a : b);
const most = (a: bigint, b: bigint) => (a > b ? a : b);

export interface KeeperDeps {
  client: PublicClient;
  repo: Repo;
  router: Address;
  alarmBook: Address;
  multicall3: Address;
  morpho: Address;
  account: Address;
  send: (tx: GasCall) => Promise<Hex>;
  now: () => number;
  /** false for an open-source keeper, which runs every armed position. */
  paidOnly: boolean;
  /** Canopy's listed vaults, lowercase. Their exits run first, and only they get deallocations. Empty or unset means every vault is treated alike. */
  listed?: ReadonlySet<string>;
  /** Overrides JOB_BUDGET_MS, for tests. */
  jobBudgetMs?: number;
  /** Overrides PASS_BUDGET_MS, for tests. */
  passBudgetMs?: number;
  /** Keys left out of the shared check until a time. Defaults to one map per process. */
  quarantine?: Map<string, number>;
  /** How many times in a row each key's poke didn't fire. Defaults to one map per process. */
  misses?: Map<string, number>;
  /** Current fees, so simulations run at a real gas price. */
  fees?: () => Promise<Fees>;
  /** Overrides UNLISTED_EXIT_GAS. */
  unlistedExitGas?: bigint;
  /** Overrides CHECK_CALL_GAS. */
  checkGas?: bigint;
  /**
   * Called at the start of every pass that writes or sends. It throws when the database no longer belongs to this
   * keeper's contracts (another deploy switched it), so a stale process can't act on someone else's state.
   */
  fence?: () => Promise<void>;
}

/**
 * Whether an exit job gets a listed vault's treatment (the fast loop, the high gas cap, deallocations): the vault is
 * listed AND the alarm key is one of that vault's own presets or its five published loss levels (isOwnKey). Arming is open to anyone, so a position on a listed vault
 * can carry keys registered on contracts of the owner's choosing; those jobs are the owner's own business, not the vault's.
 * With no listed set every vault is treated alike.
 */
const isListedJob = (d: KeeperDeps, j: { target: Address; key: Hex }) => !d.listed?.size || (d.listed.has(j.target.toLowerCase()) && isOwnKey(j.target, j.key));
const exitGasCap = (d: KeeperDeps, j: ExitJob) => {
  const cap = isListedJob(d, j) ? MAX_TX_GAS : (d.unlistedExitGas ?? UNLISTED_EXIT_GAS);
  return j.swaps ? least(cap, SWAP_EXIT_GAS) : cap;
};
const prepFor = (d: KeeperDeps, j: { target: Address; key: Hex }) => (isListedJob(d, j) ? deallocateCalls(d.client, d.morpho, j.target, d.account) : Promise.resolve([]));

class OverBudget extends Error {}

/**
 * Gives up waiting on a job after `ms`. A read in flight can't be cancelled, so the job is told through its signal
 * instead: it checks the signal before every send, and a job that runs on past its budget never sends late.
 */
async function withBudget<T>(job: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new OverBudget(`over the ${ms} ms budget`);
      stop.abort(e);
      reject(e);
    }, ms);
  });
  try {
    return await Promise.race([job(stop.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ExitJob {
  posId: Hex; key: Hex; owner: Address; target: Address; firedAt: number;
  /** Whether `key` is one of `target`'s own presets or loss levels, worked out when the job is queued. The queue orders listed jobs by it. */
  preset?: boolean;
  /** Whether the position has owner swap legs. Set from the database when the job runs, never stored: such an exit runs alone. */
  swaps?: boolean;
  /** Decimal NFT id; absent or zero for ERC-20 positions. */
  tokenId?: string;
}

export const isNftJob = (j: ExitJob) => j.tokenId !== undefined && BigInt(j.tokenId) !== 0n;

type DueJob = { id: string; payload: unknown; attempts: number };
type SimResult = { status: string; data: Hex; gasUsed: bigint; logs?: readonly unknown[] };

/**
 * Simulates one call at current fees and returns the gas limit to send it under, or null if it would revert or needs
 * more than `cap`. A node that can't simulate gets the larger of `cap` and `floor`, so a send is never left without a limit.
 * `floor` is the least the limit may be, whatever the simulation used: see READ_GAS_FLOOR.
 */
export async function gasFor(d: KeeperDeps, call: PlainCall, cap: bigint, floor = 0n): Promise<{ gas: bigint; sim?: SimResult } | null> {
  const ceiling = most(cap, floor);
  let sim: SimResult | undefined;
  try {
    const fees = d.fees ? await d.fees().catch(() => undefined) : undefined;
    // The simulation gets the same limit the send would, so a contract that burns gas can't spend the node's whole cap on it.
    const out = await d.client.simulateCalls({ account: d.account, calls: [{ to: call.to, data: call.data, gas: ceiling, ...fees }] as never });
    sim = (out.results as readonly SimResult[])[0];
  } catch {
    return { gas: ceiling };
  }
  if (!sim || sim.status !== "success") return null;
  const used = sim.gasUsed ?? 0n;
  if (used > cap) return null;
  return { gas: least(most(limitFromSim(used), floor), ceiling), sim };
}

/**
 * An unlisted exit that was refused for gas, or that was sent and left the owner's exitable balance where it was, backs
 * off exponentially and ends after MAX_STRIKES. A contract can't make the keeper pay for it every 30 seconds for a day.
 */
async function strike(d: KeeperDeps, job: DueJob, why: "exit_gas_refused" | "exit_stalled" | "exit_rejected") {
  await d.repo.bump(why);
  if ((await d.repo.strikeJob(job.id, d.now(), 2 * RETRY_SEC, MAX_STRIKES)).done) await d.repo.bump("exit_given_up");
}

const balanceCall = (token: Address, who: Address) => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [who] }),
});

/** Applies the gate to one simulated exit: three balance reads at `before`, then the same three at `after`. */
function gateOne(results: readonly SimResult[], exitAt: number, before: number, after: number, asset: Address) {
  const bal = (i: number) => {
    const r = results[i]!;
    return r.status === "success" ? decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: r.data }) : 0n;
  };
  if (results[exitAt]?.status !== "success") return { ok: false as const, reason: "exit reverted" };
  if (bal(after + 2) !== bal(before + 2)) return { ok: false as const, reason: "keeper balance changed" };
  return judge([bal(before)], [bal(after)], [bal(before + 1)], [bal(after + 1)], [asset]);
}

type Check = { status: "success"; result: boolean } | { status: "failure"; error: unknown };

/** One key checked in its own read, with its own gas, so the node's cap and the other keys don't change what it answers. */
async function checkAlone(d: KeeperDeps, key: Hex): Promise<Check> {
  try {
    const out = await d.client.call({ to: d.alarmBook, data: encodeFunctionData({ abi: alarmBookAbi, functionName: "check", args: [key] }), gas: CHECK_ALONE_GAS });
    if (!out.data) throw new Error("no answer to the check");
    return { status: "success", result: decodeFunctionResult({ abi: alarmBookAbi, functionName: "check", data: out.data }) };
  } catch (error) {
    return { status: "failure", error };
  }
}

/**
 * Checks keys in one Multicall3 request, sent with an explicit gas (viem's multicall can't set one, and a node's own cap
 * would decide how many keys fit). Each check that reverts, including with NotEnoughGas once an earlier key has used the
 * gas up, comes back as a failure of its own. `threw` means the request itself was refused, not just its checks.
 */
async function checkShared(d: KeeperDeps, keys: Hex[]): Promise<{ checks: Check[]; threw: boolean }> {
  try {
    const calls = keys.map((key) => ({ target: d.alarmBook, allowFailure: true, callData: encodeFunctionData({ abi: alarmBookAbi, functionName: "check", args: [key] }) }));
    const out = await d.client.call({
      to: d.multicall3,
      data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] }),
      gas: d.checkGas ?? CHECK_CALL_GAS,
    });
    if (!out.data) throw new Error("no answer to the shared check");
    const results = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: out.data }) as readonly { success: boolean; returnData: Hex }[];
    if (results.length !== keys.length) throw new Error("the shared check answered for the wrong number of keys");
    const checks = results.map((x): Check => {
      if (!x.success) return { status: "failure", error: new Error(`check reverted ${x.returnData.slice(0, 10)}`) };
      try {
        return { status: "success", result: decodeFunctionResult({ abi: alarmBookAbi, functionName: "check", data: x.returnData }) as boolean };
      } catch (error) {
        return { status: "failure", error };
      }
    });
    return { checks, threw: false };
  } catch (error) {
    return { checks: keys.map(() => ({ status: "failure", error }) as Check), threw: true };
  }
}

/** Splits keys into shared requests of CHECKS_PER_CALL. */
function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Shared requests in flight at once, so a long key list doesn't open hundreds of connections to the node. */
export const CHECK_CONCURRENCY = 8;

/**
 * Every key checked in shared requests of CHECKS_PER_CALL. A request that is refused fails only its own keys; `threw` is
 * set only when every request was, which is a node that won't take this kind of call at all.
 */
async function checkAll(d: KeeperDeps, keys: Hex[]): Promise<{ checks: Check[]; threw: boolean; requests: number }> {
  const parts: { checks: Check[]; threw: boolean }[] = [];
  const batches = chunks(keys, CHECKS_PER_CALL);
  for (const wave of chunks(batches, CHECK_CONCURRENCY)) parts.push(...(await Promise.all(wave.map((part) => checkShared(d, part)))));
  return { checks: parts.flatMap((p) => p.checks), threw: parts.length > 0 && parts.every((p) => p.threw), requests: batches.length };
}

/** Below this many keys, a group that failed together is checked one key at a time instead of being split again. */
export const SPLIT_BELOW = 5;
/** Shared requests one pass may spend looking for the key that sinks a group. Past it, the rest are checked one by one. */
export const MAX_SPLIT_REQUESTS = 64;
/** A key whose poke didn't fire is left out this long the first time, twice as long each time after, up to an hour. */
export const MISS_QUARANTINE_SEC = 60;
const MISSES = new Map<string, number>();

type Pass = { q: Map<string, number>; now: number; out: Map<Hex, Check>; requests: number };

/** Checks each key alone. Any that fails is left out of the shared check for QUARANTINE_SEC. Returns whether one did. */
async function settleAlone(d: KeeperDeps, p: Pass, keys: Hex[]) {
  let found = false;
  for (const key of keys) {
    const c = await checkAlone(d, key);
    p.out.set(key, c);
    if (c.status === "failure") {
      p.q.set(key.toLowerCase(), p.now + QUARANTINE_SEC);
      found = true;
    }
  }
  return found;
}

/**
 * Finds the keys that sink a group of checks that failed together. The group is split in half and each half checked as
 * one request, recursively, so a burner among thousands of keys costs a few dozen requests. A small group is checked
 * key by key. If every key answers alone, one of them sinks only a shared request (it can read gasleft() and burn only
 * a frame deeper), so each is checked in a shared request of its own, and one that fails there is left out too.
 */
async function settle(d: KeeperDeps, p: Pass, group: Hex[], threw: boolean) {
  if (threw || group.length < SPLIT_BELOW || p.requests >= MAX_SPLIT_REQUESTS) {
    if (await settleAlone(d, p, group)) return;
    // A node that refuses shared requests outright says nothing about the keys, so nothing is left out for it.
    if (threw || p.requests >= MAX_SPLIT_REQUESTS) return;
    for (const key of group) {
      p.requests++;
      if ((await checkShared(d, [key])).checks[0]?.status !== "success") p.q.set(key.toLowerCase(), p.now + QUARANTINE_SEC);
    }
    return;
  }
  const half = Math.ceil(group.length / 2);
  for (const part of [group.slice(0, half), group.slice(half)]) {
    const { checks, threw: refused, requests } = await checkAll(d, part);
    p.requests += requests;
    const bad = part.filter((_, i) => checks[i]?.status !== "success");
    for (const [i, key] of part.entries()) if (checks[i]?.status === "success") p.out.set(key, checks[i]!);
    // The whole request failed: split it again. Only some checks failed: those keys answer for themselves.
    if (bad.length === part.length) await settle(d, p, part, refused);
    else if (bad.length > 0) await settleAlone(d, p, bad);
  }
}

/** Leaves a key whose poke didn't fire out of the checks for a while, longer each time it happens again. */
function missed(d: KeeperDeps, q: Map<string, number>, key: Hex, now: number) {
  const m = d.misses ?? MISSES;
  if (m.size > 100_000) m.clear();
  const n = (m.get(key.toLowerCase()) ?? 0) + 1;
  m.set(key.toLowerCase(), n);
  q.set(key.toLowerCase(), now + Math.min(MISS_QUARANTINE_SEC * 2 ** (n - 1), 6 * QUARANTINE_SEC));
}

/** What a simulated poke returned: whether it fired. Unknown if the node gave nothing to decode. */
function pokeFires(sim: SimResult): boolean | undefined {
  try {
    return decodeFunctionResult({ abi: alarmBookAbi, functionName: "poke", data: sim.data }) as boolean;
  } catch {
    return undefined;
  }
}

const PENDING_TOPIC = toEventSelector(getAbiItem({ abi: alarmBookAbi, name: "Pending" }));

/**
 * Whether a simulated poke that returned false began a DRAIN confirmation (it emitted Pending). When the node gave no logs
 * the answer comes from the detector's kind, so a DRAIN key is poked once and the chain says afterwards what happened.
 */
async function startsConfirmation(d: KeeperDeps, key: Hex, sim: SimResult): Promise<boolean> {
  if (sim.logs) return (sim.logs as readonly { topics?: readonly string[] }[]).some((l) => l.topics?.[0]?.toLowerCase() === PENDING_TOPIC);
  return (await d.repo.detectorKind(key).catch(() => null)) === Kind.DRAIN;
}

/** When AlarmBook first saw a DRAIN key's drop and is waiting to confirm it (0: not waiting). Unknown if the read fails. */
async function pendingAt(d: KeeperDeps, key: Hex): Promise<bigint | undefined> {
  try {
    const s = await d.client.readContract({ address: d.alarmBook, abi: alarmBookAbi, functionName: "state", args: [key] });
    return BigInt(s[6]);
  } catch {
    return undefined;
  }
}

/** Whether the alarm is live after a poke landed. Unknown if the read fails. */
async function firedNow(d: KeeperDeps, key: Hex): Promise<boolean | undefined> {
  try {
    const live = await d.client.readContract({ address: d.alarmBook, abi: alarmBookAbi, functionName: "isLive", args: [key, BigInt(ALARM_TTL)] });
    return typeof live === "boolean" ? live : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pokes every armed key whose on-chain condition has tripped. Returns the keys it poked and saw fire.
 * Arming is open to anyone, and a key can point at a contract that burns all the gas it is given. In the shared check
 * that would starve the keys after it, so the keys of a failed request are searched for the one that sank it, and that
 * key is left out of the shared check for a while. The honest keys around it are still poked this pass.
 * The check runs as a read, where a contract can see a zero gas price and answer differently from a real transaction.
 * So each poke is simulated at real fees first, and the chain is asked afterwards whether it fired. A key that reads as
 * tripped but doesn't fire is left out for a while too, so it can't cost a transaction every second.
 */
export async function pokeTripped(d: KeeperDeps): Promise<Hex[]> {
  await d.fence?.();
  const q = d.quarantine ?? QUARANTINE;
  const now = d.now();
  for (const [k, until] of q) if (until <= now) q.delete(k);
  const keys = ((await d.repo.liveKeys(d.paidOnly ? now : undefined)) as Hex[]).filter((k) => !q.has(k.toLowerCase()));
  if (keys.length === 0) return [];
  // Twenty keys to a request, a few requests at a time: the cost per second grows slowly with the number of armed alarms.
  const { checks: shared, threw } = await checkAll(d, keys);
  const p: Pass = { q, now, out: new Map(), requests: 0 };
  const failed: Hex[] = [];
  for (const [i, key] of keys.entries()) {
    const c = shared[i];
    if (c?.status === "success") p.out.set(key, c);
    else failed.push(key);
  }
  if (failed.length > 0) await settle(d, p, failed, threw);

  const poked: Hex[] = [];
  for (const key of keys) {
    let checked = false;
    try {
      const c = p.out.get(key) ?? ({ status: "failure", error: new Error("left out after a failed shared check") } as Check);
      if (c.status === "failure") throw c.error;
      if (q.has(key.toLowerCase()) || !c.result) continue;
      checked = true;
      const call = { to: d.alarmBook, data: encodeFunctionData({ abi: alarmBookAbi, functionName: "poke", args: [key] }) };
      const g = await gasFor(d, call, POKE_CALL_GAS, READ_GAS_FLOOR);
      if (!g) {
        // Reverts in simulation, or needs more than a poke may use: a miss like any other, so it backs off.
        console.warn("poke", key, "reverts or needs too much gas in simulation");
        missed(d, q, key, now);
        await d.repo.bump("poke_miss");
        continue;
      }
      // A poke that doesn't fire may still be progress: the first one on a DRAIN drop starts its confirmation.
      const simFalse = g.sim !== undefined && pokeFires(g.sim) === false;
      if (simFalse && !(await startsConfirmation(d, key, g.sim!))) {
        missed(d, q, key, now);
        await d.repo.bump("poke_miss");
        continue;
      }
      // What the key's drop sighting was before this poke, so a later one can tell whether the poke made it.
      const before = await pendingAt(d, key);
      await d.send({ ...call, gas: g.gas });
      if ((await firedNow(d, key)) === false) {
        const at = await pendingAt(d, key);
        // Progress only if this poke recorded the sighting. An old one (its window is the registrant's choice) is not.
        if (at !== undefined && at > 0n && before !== undefined && at !== before) {
          // Progress, not a miss: the drop is recorded, and a poke DRAIN_CONFIRM seconds on can fire it. Until then check() reads
          // false, so the key is left alone for that long and then comes back at its normal pace.
          (d.misses ?? MISSES).delete(key.toLowerCase());
          q.set(key.toLowerCase(), now + DRAIN_CONFIRM_SEC + 2);
          await d.repo.bump("poke_pending");
          continue;
        }
        missed(d, q, key, now);
        await d.repo.bump("poke_miss");
        continue;
      }
      (d.misses ?? MISSES).delete(key.toLowerCase());
      await d.repo.bump("poke_ok");
      poked.push(key);
    } catch (e) {
      console.warn("poke", key, (e as Error).message);
      await d.repo.bump("poke_fail");
      // A key that passed its check but whose poke could not be sent or landed backs off like one that did not fire.
      if (checked) missed(d, q, key, now);
    }
  }
  return poked;
}

/** Queues exits straight after a poke, so an alarm this keeper fired doesn't wait for the indexer. */
export async function pokeAndQueue(d: KeeperDeps) {
  for (const key of await pokeTripped(d)) {
    const state = await d.client.readContract({ address: d.alarmBook, abi: alarmBookAbi, functionName: "state", args: [key] });
    // A node a block behind reads no alarm yet. The indexer's record picks this one up instead.
    if (state[1] !== 0n) await onFired(d, key, Number(state[1]));
  }
}

/**
 * Rolls SHARE_DROP and DRAIN baselines forward, so those alarms measure against current values.
 * A DRAIN key needs a sample whenever assets fall below its lowest reading, because that sample is what keeps a flash deposit out of the next baseline. Otherwise it costs gas only when a period ends.
 * Anyone with a plan can arm thousands of these on a contract of their own, so the listed vaults' presets always go, and
 * at most `max` others per pass, least recently sent first. Each send is simulated first and carries a capped gas limit,
 * and a SHARE_DROP checkpoint whose simulation moves no baseline isn't sent.
 */
export async function checkpointKeys(d: KeeperDeps, keys: Hex[], max = MAX_CHECKPOINTS_PER_PASS) {
  await d.fence?.();
  let first = keys;
  let rest: Hex[] = [];
  if (d.listed?.size) {
    const targets = await d.repo.detectorTargets(keys);
    const own = (k: Hex) => {
      const t = targets.get(k.toLowerCase());
      // A listed vault's presets and its five alarm levels. Keys come from liveKeys, so they are already paid-only when the keeper is.
      return t !== undefined && d.listed!.has(t) && isOwnKey(t as Address, k);
    };
    first = keys.filter(own);
    rest = keys.filter((k) => !own(k)).sort((a, b) => (CHECKPOINTED.get(a.toLowerCase()) ?? 0) - (CHECKPOINTED.get(b.toLowerCase()) ?? 0)).slice(0, max);
    if (CHECKPOINTED.size > 100_000) CHECKPOINTED.clear();
  }
  for (const key of [...first, ...rest]) {
    CHECKPOINTED.set(key.toLowerCase(), d.now());
    try {
      // Every read carries a gas limit: the target is a contract anyone can write, and a node's own cap is not a bound.
      const det = await d.client.readContract({ address: d.alarmBook, abi: alarmBookAbi, functionName: "detector", args: [key], gas: CHECK_ALONE_GAS } as never) as { kind: number; target: Address; window: number };
      if (det.kind === Kind.DRAIN) {
        const [, , snapAt, low] = await d.client.readContract({ address: d.alarmBook, abi: alarmBookAbi, functionName: "state", args: [key], gas: CHECK_ALONE_GAS } as never) as readonly bigint[];
        const assets = await d.client.readContract({ address: det.target, abi: vaultAbi, functionName: "totalAssets", gas: CHECK_ALONE_GAS } as never) as bigint;
        if (d.now() < Number(snapAt) + det.window / 2 && assets >= low!) continue;
      }
      const call = { to: d.alarmBook, data: encodeFunctionData({ abi: alarmBookAbi, functionName: "checkpoint", args: [key] }) };
      const g = await gasFor(d, call, POKE_CALL_GAS, READ_GAS_FLOOR);
      if (!g) throw new Error("reverts or needs too much gas in simulation");
      // SHARE_DROP only ever writes with an event, when the price rose. No event means nothing would change.
      if (det.kind === Kind.SHARE_DROP && g.sim?.logs && g.sim.logs.length === 0) continue;
      await d.send({ ...call, gas: g.gas });
    } catch (e) {
      console.warn("checkpoint", key, (e as Error).message);
    }
  }
}

/** Where the alarm queue loop has read up to, and when it last went over the whole day. */
export interface AlarmCursor { seq: bigint; sweptAt: number }
/** How often the alarm queue loop goes over every alarm of the last day, not just new ones. */
export const ALARM_SWEEP_SEC = 60;

/**
 * Queues exits for alarms another process recorded. New alarms come from a cursor, so a quiet pass costs one indexed
 * query instead of the whole day's alarms and every position armed with them. Once a minute it goes over the whole day
 * again, which picks up positions armed, and plans paid, after an alarm fired.
 */
export async function queueNewAlarms(d: KeeperDeps, c: AlarmCursor) {
  await d.fence?.();
  const since = d.now() - ALARM_TTL;
  const sweep = d.now() - c.sweptAt >= ALARM_SWEEP_SEC;
  const rows = sweep ? await d.repo.recentAlarms(since) : await d.repo.alarmsAfter(c.seq, since);
  for (const a of rows) {
    await onFired(d, a.key as Hex, Number(a.fired_at));
    if (BigInt(a.seq) > c.seq) c.seq = BigInt(a.seq);
  }
  if (sweep) c.sweptAt = d.now();
}

/** Queues exits for a fired alarm. Canopy's keeper skips unpaid wallets; no contract does. */
export async function onFired(d: KeeperDeps, key: Hex, firedAt: number): Promise<number> {
  await d.fence?.();
  let queued = 0;
  for (const p of await d.repo.armedWith(key)) {
    if (d.paidOnly && !keeperShouldRun(await d.repo.paidUntil(p.owner), d.now())) continue;
    const job: ExitJob = { posId: p.pos_id as Hex, key, owner: p.owner as Address, target: p.target as Address, firedAt, tokenId: String(p.token_id), preset: isOwnKey(p.target as Address, key) };
    await d.repo.enqueue("exit", `${key}:${firedAt}:${p.pos_id}`, job, d.now());
    queued++;
  }
  return queued;
}

/** Simulates [deallocate..., exit] and applies the gate. Failed deallocations are tolerated; a failed exit is not. */
export async function gateExit(d: KeeperDeps, j: ExitJob, asset: Address, amount: bigint, prep: PlainCall[]) {
  const watch = [j.owner, d.router, d.account];
  const reads = watch.map((w) => balanceCall(asset, w));
  const exitCall = {
    to: d.router,
    data: encodeFunctionData({ abi: routerAbi, functionName: "exit", args: [j.posId, j.key, amount] }),
  };
  const calls = [...reads, ...prep, exitCall, ...reads];
  const { results } = await d.client.simulateCalls({ account: d.account, calls });
  const exitAt = reads.length + prep.length;
  const sim = results as readonly SimResult[];
  // What the transaction would use: the deallocations and the exit, not the reads around them.
  const gas = sim.slice(reads.length, exitAt + 1).reduce((s, r) => s + (r.gasUsed ?? 0n), 0n);
  return { ...gateOne(sim, exitAt, 0, exitAt + 1, asset), gas };
}

/**
 * What became of one exit: finished, worth another try, refused because it needs more gas than its vault may use, or
 * sent without moving the owner's exitable balance.
 */
export type ExitOutcome = "done" | "retry" | "refused" | "stalled";

/**
 * Runs one exit. Retries end when the 24h alarm expires. Nothing is sent once `signal` aborts. The transaction carries
 * a gas limit from its own simulation, and an unlisted vault's exit that needs more than its cap is refused unsent.
 */
export async function runExit(d: KeeperDeps, j: ExitJob, signal?: AbortSignal): Promise<ExitOutcome> {
  if (d.now() > j.firedAt + ALARM_TTL) return "done";
  if (isNftJob(j)) return runNftExit(d, j, signal);
  const shares = await d.client.readContract({ address: j.target, abi: erc20Abi, functionName: "balanceOf", args: [j.owner] });
  const allowed = await d.client.readContract({ address: j.target, abi: erc20Abi, functionName: "allowance", args: [j.owner, d.router] });
  const total = shares < allowed ? shares : allowed;
  if (total === 0n) return "done";

  const asset = await d.client.readContract({ address: j.target, abi: vaultAbi, functionName: "asset" });
  const direct = { to: d.router, data: encodeFunctionData({ abi: routerAbi, functionName: "exit", args: [j.posId, j.key, 0n] }) };
  const prep = await prepFor(d, j);
  let used = 0n;
  const amount = await sizeExit(total, async (a) => {
    try {
      const g = await gateExit(d, j, asset, a, prep);
      if (g.ok) used = g.gas;
      return g.ok;
    } catch {
      return false;
    }
  });
  if (amount === 0n) {
    await d.repo.bump("gate_reject");
    return "retry";
  }
  if (used > exitGasCap(d, j)) return "refused";
  const gas = least(limitFromSim(used) + EXIT_SWAP_HEADROOM, MAX_TX_GAS);

  const exitData = encodeFunctionData({ abi: routerAbi, functionName: "exit", args: [j.posId, j.key, amount] });
  signal?.throwIfAborted();
  if (prep.length === 0) {
    await d.send({ ...direct, data: exitData, gas });
  } else {
    const all = [...prep.map((c) => ({ target: c.to, allowFailure: true, callData: c.data })), { target: d.router, allowFailure: false, callData: exitData }];
    await d.send({ to: d.multicall3, data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [all] }), gas });
  }
  // A redeem can pay part and hand the rest back without reverting, so only the chain can say this is finished.
  const [left, room] = await Promise.all([
    d.client.readContract({ address: j.target, abi: erc20Abi, functionName: "balanceOf", args: [j.owner] }),
    d.client.readContract({ address: j.target, abi: erc20Abi, functionName: "allowance", args: [j.owner, d.router] }),
  ]);
  const after = left < room ? left : room;
  if (after === 0n) return "done";
  return after < total ? "retry" : "stalled";
}

/**
 * What an LP NFT still holds that the router can move, or null when the job is finished: the owner sold, moved or
 * burned it, revoked the router, or nothing is left in it. An exit spends a single-token approval, so an exit that
 * paid only one token (the other refused to move) also ends here, with the rest still owed inside the owner's NFT.
 */
export async function nftLeft(d: KeeperDeps, j: ExitJob): Promise<{ token0: Address; token1: Address } | null> {
  const id = BigInt(j.tokenId!);
  const read = <T>(functionName: string, args: readonly unknown[]) =>
    d.client.readContract({ address: j.target, abi: positionManagerAbi, functionName, args, gas: 200_000n } as never) as Promise<T>;
  // Read failures retry; a timeout is not evidence that an NFT burned.
  const holder = await read<Address>("ownerOf", [id]);
  if (holder.toLowerCase() !== j.owner.toLowerCase()) return null;
  const [approved, all] = await Promise.all([read<Address>("getApproved", [id]), read<boolean>("isApprovedForAll", [holder, d.router])]);
  if (!all && approved.toLowerCase() !== d.router.toLowerCase()) return null;
  const p = await read<readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]>("positions", [id]);
  if (p[7] === 0n && p[10] === 0n && p[11] === 0n) return null;
  return { token0: p[2], token1: p[3] };
}

/**
 * Exits one LP NFT. It is all or nothing, so there is no sizing. The gate watches both pool tokens and the
 * stablecoin, which a stablecoin harbour swaps into: the owner must gain, and neither the router nor this keeper may.
 */
export async function runNftExit(d: KeeperDeps, j: ExitJob, signal?: AbortSignal): Promise<ExitOutcome> {
  const left = await nftLeft(d, j);
  if (!left) return "done";
  const stable = (await d.client.readContract({ address: d.router, abi: routerAbi, functionName: "STABLE" })) as Address;
  const tokens = [...new Set([left.token0, left.token1, stable].map((t) => t.toLowerCase() as Address))];
  const watch = [j.owner, d.router, d.account];
  const reads = tokens.flatMap((t) => watch.map((w) => ({ ...balanceCall(t, w), gas: 200_000n })));
  const exitCall = { to: d.router, data: encodeFunctionData({ abi: routerAbi, functionName: "exit", args: [j.posId, j.key, 0n] }) };
  const fees = await d.fees?.();
  const { results } = await d.client.simulateCalls({ account: d.account, calls: [...reads, { ...exitCall, gas: exitGasCap(d, j), ...fees }, ...reads] as never });
  const sim = results as readonly SimResult[];
  if (sim.length !== reads.length * 2 + 1 || sim.some((r) => r.status !== "success")) {
    await d.repo.bump("gate_reject");
    return "retry";
  }
  const bal = (i: number) => {
    const r = sim[i]!;
    return r.status === "success" ? decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: r.data }) : 0n;
  };
  const after = reads.length + 1;
  // Balance of watcher `w` for every token, from the reads starting at `base`.
  const of = (base: number, w: number) => tokens.map((_, t) => bal(base + t * watch.length + w));
  const keeperMoved = of(0, 2).some((b, t) => b !== of(after, 2)[t]);
  const ok = sim[reads.length]?.status === "success" && !keeperMoved && judge(of(0, 0), of(after, 0), of(0, 1), of(after, 1), tokens).ok;
  if (!ok) {
    await d.repo.bump("gate_reject");
    return "retry";
  }
  const used = sim[reads.length]!.gasUsed;
  if (used === undefined || used > exitGasCap(d, j)) return "refused";
  signal?.throwIfAborted();
  await d.send({ ...exitCall, gas: least(limitFromSim(used) + EXIT_SWAP_HEADROOM, MAX_TX_GAS) });
  return (await nftLeft(d, j)) ? "retry" : "done";
}

/**
 * Pays out what an owner couldn't receive at exit time, once the token moves again. Anyone may do this, and it only pays
 * the owner. Canopy's keeper does it for owners with a live plan, a few per pass, each under a gas cap: the token is
 * whatever the vault paid out, so it may be a contract built to burn gas.
 */
export async function claimOwed(d: KeeperDeps, max = MAX_OWED_PER_PASS) {
  await d.fence?.();
  for (const o of await d.repo.openOwed(d.paidOnly ? d.now() : undefined, max)) {
    const args = [o.owner as Address, o.token as Address] as const;
    try {
      await d.client.simulateContract({ address: d.router, abi: routerAbi, functionName: "claimOwed", args, account: d.account });
    } catch {
      continue; // Still paused, or already claimed.
    }
    const call = { to: d.router, data: encodeFunctionData({ abi: routerAbi, functionName: "claimOwed", args }) };
    const g = await gasFor(d, call, SMALL_CALL_GAS);
    if (!g) continue;
    await d.send({ ...call, gas: g.gas });
  }
}

/** What each job can still exit: the shares its owner holds and has approved. Zero means the job is finished. */
async function exitable(d: KeeperDeps, jobs: ExitJob[]): Promise<bigint[]> {
  const out = await d.client.multicall({
    multicallAddress: d.multicall3,
    allowFailure: false,
    contracts: jobs.flatMap((j) => [
      { address: j.target, abi: erc20Abi, functionName: "balanceOf", args: [j.owner] },
      { address: j.target, abi: erc20Abi, functionName: "allowance", args: [j.owner, d.router] },
    ]),
  }) as unknown as bigint[];
  return jobs.map((_, i) => (out[2 * i]! < out[2 * i + 1]! ? out[2 * i]! : out[2 * i + 1]!));
}

/**
 * Exits many positions in one vault with one transaction. Each exit may fail alone, and the chain says afterwards which landed.
 * The gas limit comes from the simulation, because with failures allowed an estimate could settle on too little and only the
 * exits would fail. Bundles stay within one vault, so a vault built to burn gas can only cost its own holders.
 * Returns the jobs for the one-by-one path: those the gate turned down, for it to size, and any whose exit alone costs
 * more than the bundle budget, which only ever run on their own. A job that fits alone but not beside the others stays
 * due; it is the oldest of its vault's jobs, so it leads the next pass's bundle and can't be passed over twice.
 */
export async function runBundle(d: KeeperDeps, due: DueJob[], signal?: AbortSignal): Promise<DueJob[]> {
  const live = d.now();
  // An exit with owner swap legs runs token code the owner chose, so it never shares a transaction; the caller sends it alone.
  const open = due.filter((x) => live <= (x.payload as ExitJob).firedAt + ALARM_TTL && !(x.payload as ExitJob).swaps && !isNftJob(x.payload as ExitJob));
  const totals = await exitable(d, open.map((x) => x.payload as ExitJob));
  const jobs = open.flatMap((job, i) => (totals[i]! > 0n ? [{ job, j: job.payload as ExitJob, amount: totals[i]! }] : []));
  const skipped = due.filter((x) => !jobs.some((y) => y.job.id === x.id));
  if (jobs.length === 0) return skipped;

  const target = jobs[0]!.j.target;
  const asset = await d.client.readContract({ address: target, abi: vaultAbi, functionName: "asset" });
  const prep = await prepFor(d, jobs[0]!.j);
  const exitData = (x: (typeof jobs)[number]) => encodeFunctionData({ abi: routerAbi, functionName: "exit", args: [x.j.posId, x.j.key, x.amount] });
  const reads = (owner: Address) => [owner, d.router, d.account].map((w) => balanceCall(asset, w));
  const STEP = 7; // Three reads, the exit, three reads.
  const calls = [...prep, ...jobs.flatMap((x) => [...reads(x.j.owner), { to: d.router, data: exitData(x) }, ...reads(x.j.owner)])];
  const { results } = await d.client.simulateCalls({ account: d.account, calls });
  const sim = results as readonly SimResult[];

  const gasOf = (from: number, to: number) => sim.slice(from, to).reduce((s, r) => s + (r.gasUsed ?? 0n), 0n);
  const prepGas = gasOf(0, prep.length);
  let gas = prepGas;
  const picked: typeof jobs = [];
  const refused: DueJob[] = [];
  for (const [i, x] of jobs.entries()) {
    const at = prep.length + i * STEP;
    if (!gateOne(sim, at + 3, at, at + 4, asset).ok) {
      refused.push(x.job);
      continue;
    }
    const cost = sim[at + 3]!.gasUsed ?? 0n;
    if (cost > exitGasCap(d, x.j)) {
      await strike(d, x.job, "exit_gas_refused");
      continue;
    }
    // Too big to share a transaction with anything, ever: it runs alone, where its own gas limit applies.
    if (prepGas + cost > BUNDLE_GAS) {
      refused.push(x.job);
      continue;
    }
    if (gas + cost > BUNDLE_GAS) continue;
    gas += cost;
    picked.push(x);
  }
  if (picked.length === 0) return [...skipped, ...refused];

  const all = [
    ...prep.map((c) => ({ target: c.to, allowFailure: true, callData: c.data })),
    ...picked.map((x) => ({ target: d.router, allowFailure: true, callData: exitData(x) })),
  ];
  signal?.throwIfAborted();
  await d.send({ to: d.multicall3, data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [all] }), gas: least(limitFromSim(gas) + EXIT_SWAP_HEADROOM * BigInt(picked.length), MAX_TX_GAS) });
  const left = await exitable(d, picked.map((x) => x.j));
  for (const [i, x] of picked.entries()) {
    if (left[i] === 0n) await d.repo.finishJob(x.job.id);
    else if (left[i]! >= x.amount && !isListedJob(d, x.j)) await strike(d, x.job, "exit_stalled");
    else await d.repo.retryJob(x.job.id, d.now() + RETRY_SEC);
  }
  return [...skipped, ...refused];
}

/**
 * Works through due exit jobs, one transaction per vault when several are due. A failed job waits 30 s and tries again; it
 * never blocks the others. Listed vaults' jobs are fetched first, each job has a time budget and the pass has one too, so
 * a contract built to stall the keeper only delays itself. `scope` lets the listed vaults run in a loop of their own.
 */
export async function drainExits(d: KeeperDeps, scope: "all" | "listed" | "unlisted" = "all") {
  await d.fence?.();
  const budget = d.jobBudgetMs ?? JOB_BUDGET_MS;
  const passEnd = Date.now() + (d.passBudgetMs ?? PASS_BUDGET_MS);
  const listed = [...(d.listed ?? [])];
  // With no listed set every vault is treated alike, so there is nothing "unlisted" to run apart.
  if (listed.length === 0 && scope === "unlisted") return;
  const order = listed.length ? { listed, only: scope === "all" ? undefined : scope } : undefined;
  const fetched = await d.repo.dueJobs("exit", d.now(), 32, order, MAX_OPEN_EXITS_PER_OWNER);
  // A job ends when its position is no longer active or no longer holds its key (disarmed, re-armed with other keys, a
  // firing reorged away). The database follows the router, so this costs no node request.
  const state = await d.repo.armedPairs(fetched.map((x) => ({ posId: (x.payload as ExitJob).posId, key: (x.payload as ExitJob).key })));
  const ended: string[] = [];
  const due: DueJob[] = [];
  for (const job of fetched) {
    const j = job.payload as ExitJob;
    const now = state.get(`${j.posId.toLowerCase()}|${j.key.toLowerCase()}`);
    if (!now) ended.push(job.id);
    else due.push({ ...job, payload: { ...j, swaps: now.hasSwaps } });
  }
  if (ended.length > 0) {
    await d.repo.dropJobs(ended);
    await d.repo.bump("exit_job_ended", ended.length);
  }
  const byVault = new Map<string, DueJob[]>();
  const single: DueJob[] = [];
  for (const job of due) {
    const j = job.payload as ExitJob;
    // An exit that runs the owner's swap legs never shares a transaction.
    if (j.swaps || isNftJob(j)) {
      single.push(job);
      continue;
    }
    // Bundles stay within one vault and one kind of job, so a listed vault's presets never share one with the owner's own keys.
    const group = `${j.target.toLowerCase()}|${isListedJob(d, j) ? "listed" : "other"}`;
    byVault.set(group, [...(byVault.get(group) ?? []), job]);
  }
  const listedFirst = (a: DueJob, b: DueJob) => Number(!isListedJob(d, a.payload as ExitJob)) - Number(!isListedJob(d, b.payload as ExitJob));
  const groups = [...byVault.values()].sort((a, b) => listedFirst(a[0]!, b[0]!));
  for (const group of groups) {
    if (Date.now() >= passEnd) break;
    if (group.length === 1) {
      single.push(...group);
      continue;
    }
    try {
      single.push(...(await withBudget((signal) => runBundle(d, group, signal), budget)));
    } catch (e) {
      console.warn("bundle", (e as Error).message);
      await d.repo.bump("bundle_error");
      if (e instanceof OverBudget) {
        for (const job of group) await d.repo.retryJob(job.id, d.now() + SLOW_RETRY_SEC);
      } else single.push(...group);
    }
  }
  single.sort(listedFirst);
  for (const job of single) {
    // Out of time: what is left stays due, and the next pass fetches listed vaults' jobs ahead of it.
    if (Date.now() >= passEnd) {
      await d.repo.bump("exit_pass_budget");
      break;
    }
    const j = job.payload as ExitJob;
    try {
      const out = await withBudget((signal) => runExit(d, j, signal), budget);
      if (out === "done") await d.repo.finishJob(job.id);
      // A listed vault's own preset keeps its fast retry whatever happened; every other job, a retry included, earns a strike.
      // So does an exit with owner swap legs, even on a listed preset: a failed swap only skips the swap (the router pays the
      // raw token), so an exit that keeps failing with legs is running the owner's own token code, and must not cost the
      // keeper a large send every 30 seconds for a day.
      else if (isListedJob(d, j) && !j.swaps) await d.repo.retryJob(job.id, d.now() + RETRY_SEC);
      else await strike(d, job, out === "refused" ? "exit_gas_refused" : out === "retry" ? "exit_rejected" : "exit_stalled");
    } catch (e) {
      console.warn("exit", j.posId, (e as Error).message);
      await d.repo.bump("exit_error");
      await d.repo.retryJob(job.id, d.now() + (e instanceof OverBudget ? SLOW_RETRY_SEC : RETRY_SEC));
    }
  }
}
