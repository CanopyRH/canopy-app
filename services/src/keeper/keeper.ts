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
