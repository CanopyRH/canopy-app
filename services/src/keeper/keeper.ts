import { decodeFunctionResult, encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { alarmBookAbi, erc20Abi, multicall3Abi, routerAbi, vaultAbi } from "../chain/abi";
import { Kind } from "../api/presets";
import { keeperShouldRun } from "../billing/prepaid";
import type { Repo } from "../store/repo";
import { deallocateCalls, type PlainCall } from "./liquidity";
import { judge, sizeExit } from "./simulate";

export const ALARM_TTL = 86_400;
export const RETRY_SEC = 30;
/** Stays well under the 16.7M gas that a single transaction may use, once the margin is added. */
export const BUNDLE_GAS = 10_000_000n;
/** Keys per check request. Each check is a few reads, so 250 stay far below a node's gas cap for a read-only call. */
export const CHECKS_PER_CALL = 250;

export interface KeeperDeps {
  client: PublicClient;
  repo: Repo;
  router: Address;
  alarmBook: Address;
  multicall3: Address;
  morpho: Address;
  account: Address;
  send: (tx: PlainCall) => Promise<Hex>;
  now: () => number;
  /** false for an open-source keeper, which runs every armed position. */
  paidOnly: boolean;
}

export interface ExitJob { posId: Hex; key: Hex; owner: Address; target: Address; firedAt: number }

type DueJob = { id: string; payload: unknown; attempts: number };
type SimResult = { status: string; data: Hex; gasUsed: bigint };

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

/** Pokes every armed key whose on-chain condition has tripped. Returns the keys it poked. */
export async function pokeTripped(d: KeeperDeps): Promise<Hex[]> {
  const keys = (await d.repo.liveKeys(d.paidOnly ? d.now() : undefined)) as Hex[];
  if (keys.length === 0) return [];
  // One RPC request checks every key, so the cost per second doesn't grow with the number of armed alarms.
  const checks = await d.client.multicall({
    multicallAddress: d.multicall3,
    allowFailure: true,
    batchSize: CHECKS_PER_CALL * 36,
    contracts: keys.map((key) => ({ address: d.alarmBook, abi: alarmBookAbi, functionName: "check", args: [key] }) as const),
  });
  const poked: Hex[] = [];
  for (const [i, key] of keys.entries()) {
    // Arming is open to anyone, so one key that reverts must not stop the rest.
    try {
      const c = checks[i]!;
      if (c.status === "failure") throw c.error;
      if (!c.result) continue;
      await d.send({ to: d.alarmBook, data: encodeFunctionData({ abi: alarmBookAbi, functionName: "poke", args: [key] }) });
      await d.repo.bump("poke_ok");
      poked.push(key);
    } catch (e) {
      console.warn("poke", key, (e as Error).message);
      await d.repo.bump("poke_fail");
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
 */
export async function checkpointKeys(d: KeeperDeps, keys: Hex[]) {
  for (const key of keys) {
    try {
      const det = await d.client.readContract({ address: d.alarmBook, abi: alarmBookAbi, functionName: "detector", args: [key] });
      if (det.kind === Kind.DRAIN) {
        const [, , snapAt, low] = await d.client.readContract({ address: d.alarmBook, abi: alarmBookAbi, functionName: "state", args: [key] });
        const assets = await d.client.readContract({ address: det.target, abi: vaultAbi, functionName: "totalAssets" });
        if (d.now() < Number(snapAt) + det.window / 2 && assets >= low) continue;
      }
      await d.send({ to: d.alarmBook, data: encodeFunctionData({ abi: alarmBookAbi, functionName: "checkpoint", args: [key] }) });
    } catch (e) {
      console.warn("checkpoint", key, (e as Error).message);
    }
  }
}

/** Queues exits for a fired alarm. Canopy's keeper skips unpaid wallets; no contract does. */
export async function onFired(d: KeeperDeps, key: Hex, firedAt: number): Promise<number> {
  let queued = 0;
  for (const p of await d.repo.armedWith(key)) {
    if (d.paidOnly && !keeperShouldRun(await d.repo.paidUntil(p.owner), d.now())) continue;
    const job: ExitJob = { posId: p.pos_id as Hex, key, owner: p.owner as Address, target: p.target as Address, firedAt };
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
  return gateOne(results as readonly SimResult[], exitAt, 0, exitAt + 1, asset);
}

/** Runs one exit. Returns "done" or "retry". Retries end when the 24h alarm expires. */
export async function runExit(d: KeeperDeps, j: ExitJob): Promise<"done" | "retry"> {
  if (d.now() > j.firedAt + ALARM_TTL) return "done";
  const shares = await d.client.readContract({ address: j.target, abi: erc20Abi, functionName: "balanceOf", args: [j.owner] });
  const allowed = await d.client.readContract({ address: j.target, abi: erc20Abi, functionName: "allowance", args: [j.owner, d.router] });
  const total = shares < allowed ? shares : allowed;
  if (total === 0n) return "done";

  const asset = await d.client.readContract({ address: j.target, abi: vaultAbi, functionName: "asset" });
  const direct = { to: d.router, data: encodeFunctionData({ abi: routerAbi, functionName: "exit", args: [j.posId, j.key, 0n] }) };
  const prep = await deallocateCalls(d.client, d.morpho, j.target, d.account);
  const amount = await sizeExit(total, async (a) => {
    try {
      return (await gateExit(d, j, asset, a, prep)).ok;
    } catch {
      return false;
    }
  });
  if (amount === 0n) {
    await d.repo.bump("gate_reject");
    return "retry";
  }

  const exitData = encodeFunctionData({ abi: routerAbi, functionName: "exit", args: [j.posId, j.key, amount] });
  if (prep.length === 0) {
    await d.send({ ...direct, data: exitData });
  } else {
    const all = [...prep.map((c) => ({ target: c.to, allowFailure: true, callData: c.data })), { target: d.router, allowFailure: false, callData: exitData }];
    await d.send({ to: d.multicall3, data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [all] }) });
  }
  // A redeem can pay part and hand the rest back without reverting, so only the chain can say this is finished.
  const [left, room] = await Promise.all([
    d.client.readContract({ address: j.target, abi: erc20Abi, functionName: "balanceOf", args: [j.owner] }),
    d.client.readContract({ address: j.target, abi: erc20Abi, functionName: "allowance", args: [j.owner, d.router] }),
  ]);
  return left === 0n || room === 0n ? "done" : "retry";
}
