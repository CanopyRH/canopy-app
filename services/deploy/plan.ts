/**
 * Turns a broadcast deployment into files a multisig can review and sign. Holds no keys and sends nothing.
 * Usage: bun deploy/plan.ts <run-latest.json> <settings.json> <out dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex } from "viem";
import { alarmBookAbi, routerAbi } from "../src/chain/abi";
import { registrationOrder } from "../src/api/presets";

export interface Settings {
  chainId: number;
  proposer: Address;
  guardian: Address;
  stable: Address;
  weth: Address;
  swapRouter: Address;
  stableFeed: Address;
  heartbeat: number;
  adminExpiry: number;
  watchers: Address[];
  vaults: Address[];
  /** The app's plan payment Safe and API address, for the web config. */
  planPayTo?: Address;
  apiUrl?: string;
  /** Testnet only: admins may be plain wallets. Refused on mainnet. */
  allowEoaAdmin?: boolean;
  /** Seconds each admin change waits in the Timelock. 0 (the default) applies a change as soon as the multisig signs. */
  timelockDelay?: number;
  /** Testnet only: deploys a TestTimelock with this delay. Refused on mainnet. */
  testTimelockDelay?: number;
}
export interface Deployment { timelock: Address; alarmBook: Address; router: Address; adapter: Address; startBlock: number }
export interface Call { to: Address; value: string; data: Hex }

const timelockAbi = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 salt) returns (bytes32)",
  "function execute(address target, uint256 value, bytes data, bytes32 salt) payable returns (bytes)",
]);

export function readBroadcast(path: string): Deployment {
  const run = JSON.parse(readFileSync(path, "utf8")) as {
    transactions: { transactionType: string; contractName: string; contractAddress: Address }[];
    receipts: { blockNumber: string }[];
  };
  const find = (name: string) => {
    const hits = run.transactions.filter((t) => t.transactionType === "CREATE" && t.contractName === name);
    if (hits.length !== 1) throw new Error(`expected one ${name}, found ${hits.length}`);
    return hits[0]!.contractAddress;
  };
  return {
    timelock: find("Timelock"), alarmBook: find("AlarmBook"), router: find("ExitRouter"), adapter: find("ERC4626Adapter"),
    startBlock: Number(run.receipts[0]!.blockNumber),
  };
}

/** Admin changes that go through the Timelock, in the order they must run. */
export function adminCalls(d: Deployment, s: Settings): { target: Address; data: Hex; label: string }[] {
  return [
    { target: d.router, label: "enable ERC4626Adapter", data: encodeFunctionData({ abi: routerAbi, functionName: "setAdapter", args: [d.adapter, true] }) },
    ...s.watchers.map((w) => ({
      target: d.alarmBook,
      label: `approve watcher ${w}`,
      data: encodeFunctionData({ abi: alarmBookAbi, functionName: "setWatcher", args: [w, true] }),
    })),
  ];
}

const salt = (label: string): Hex => keccak256(stringToHex(`canopy:v1:${label}`));

export const delayOf = (s: Settings) => s.testTimelockDelay ?? s.timelockDelay ?? 0;
export const MAINNETS = [8453, 4663];

export function timelockBatches(d: Deployment, s: Settings) {
  const calls = adminCalls(d, s);
  const wrap = (fn: "schedule" | "execute"): Call[] =>
    calls.map((c) => ({
      to: d.timelock,
      value: "0",
      data: encodeFunctionData({ abi: timelockAbi, functionName: fn, args: [c.target, 0n, c.data, salt(c.label)] }),
    }));
  return { schedule: wrap("schedule"), execute: wrap("execute"), labels: calls.map((c) => c.label) };
}

/** AlarmBook registration is open to anyone, so this batch needs no Timelock. */
export function presetBatch(d: Deployment, vaults: Address[]): Call[] {
  return vaults.flatMap((v) =>
    registrationOrder(v).map((x) => ({
      to: d.alarmBook,
      value: "0",
      data: encodeFunctionData({ abi: alarmBookAbi, functionName: "register", args: [x] }),
    })),
  );
}
