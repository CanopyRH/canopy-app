import { decodeEventLog, type Hex } from "viem";
import { alarmBookAbi, routerAbi } from "../chain/abi";
import { txUrl } from "../chain/addresses";

/** Events that only an admin or the guardian can cause. Each one is worth a human looking at it. */
const WATCHED = {
  ExitRouter: ["AdapterSet", "GuardianSet", "ArmingPaused"],
  AlarmBook: ["WatcherSet"],
} as const;
const ABIS = { ExitRouter: routerAbi, AlarmBook: alarmBookAbi } as const;

/** The v1 contracts are named apart in alerts (see v1.ts). */
export type AdminContract = keyof typeof WATCHED | "ExitRouter v1" | "AlarmBook v1";

export interface AdminEvent {
  contract: AdminContract;
  event: string;
  /** Argument names and values, in the order the event declares them. */
  args: [name: string, value: string][];
  tx: Hex | null;
  logIndex: number | null;
  block: bigint | null;
}

interface RawLog { data: Hex; topics: [Hex, ...Hex[]] | []; blockNumber: bigint | null; transactionHash: Hex | null; logIndex: number | null }

const MAX_VALUE = 130;
const show = (v: unknown): string => {
  const s = Array.isArray(v) ? v.join(",") : String(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s;
};

/** Returns the admin event in a log from this contract, or null for any other event. */
export function adminEventOf(contract: keyof typeof WATCHED, log: RawLog): AdminEvent | null {
  const ev = decodeEventLog({ abi: ABIS[contract], data: log.data, topics: log.topics as never, strict: false });
  if (!(WATCHED[contract] as readonly string[]).includes(ev.eventName)) return null;
  const given = (ev.args ?? {}) as Record<string, unknown>;
  const item = (ABIS[contract] as readonly { type: string; name?: string; inputs?: readonly { name?: string }[] }[]).find((x) => x.type === "event" && x.name === ev.eventName);
  const names = (item?.inputs ?? []).map((i) => i.name ?? "");
  return {
    contract,
    event: ev.eventName,
    args: names.map((n) => [n, show(given[n])] as [string, string]),
    tx: log.transactionHash,
    logIndex: log.logIndex,
    block: log.blockNumber,
  };
}

/** One id per log, so a replayed log queues one alert. */
export const adminAlertId = (e: AdminEvent) => `admin:${e.tx}:${e.logIndex}`;

/** The operator message: what changed, with which values, and where to look it up. */
export function adminAlertText(chainId: number, e: AdminEvent): string {
  const args = e.args.map(([n, v]) => `${n}=${v}`).join(", ");
  const link = txUrl(chainId, e.tx);
  return [
    `Canopy ops: admin event ${e.event} on ${e.contract}${e.block === null ? "" : ` in block ${e.block}`}.`,
    `Arguments: ${args || "none"}.`,
    link ? `Transaction: ${link}` : `Transaction: ${e.tx ?? "unknown"}`,
    "If nobody on the team expected this, follow INCIDENT.md.",
  ].join("\n");
}
