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
