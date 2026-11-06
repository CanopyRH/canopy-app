import { decodeEventLog, parseAbi, type Hex } from "viem";
import { txUrl } from "../chain/addresses";
import { adminAlertId, adminAlertText, type AdminContract, type AdminEvent } from "./admin";
import type { Log } from "./indexer";

/**
 * Following the v1 contracts until they retire. The services run on v2, so nothing exits a v1 position any more: an admin
 * change on v1 or a new v1 arm is something a person has to hear about. The event shapes are the ones deployed at the git tag
 * `v1-deployed`; v2 changed some (v1 WatcherSet is (address,bool), v1 has FeedSet and RouteSet), so they are declared here
 * and never share an ABI with the current contracts.
 *
 * Their log readers use cursors of their own (see V1_ROUTER_CURSOR), not the plain `router` and `alarms` names, because the
 * contract switch parks those. This never writes position, exit or alarm rows: it only reads logs and queues ops messages.
 */
export const v1RouterAbi = parseAbi([
  "event Armed(bytes32 indexed posId, address indexed owner, address adapter, address target, uint256 tokenId, uint8 harbour, uint16 maxSlipBps, bytes32 termsHash, bytes32[] keys)",
  "event AdapterSet(address indexed adapter, bool allowed)",
  "event FeedSet(address indexed token, address feed, uint32 heartbeat, uint8 tokenDecimals)",
  "event RouteSet(address indexed token, bytes path)",
  "event GuardianSet(address guardian)",
  "event ArmingPaused(bool paused)",
]);
export const v1AlarmBookAbi = parseAbi(["event WatcherSet(address indexed watcher, bool allowed)"]);

const V1_ROUTER_ADMIN = ["AdapterSet", "FeedSet", "RouteSet", "GuardianSet", "ArmingPaused"] as const;

/** Cursor names. Namespaced by the contract, and not matched by the switch's `router`/`alarms` patterns. */
export const v1RouterCursor = (router: string) => `v1router@${router.toLowerCase()}`;
export const v1AlarmsCursor = (alarmBook: string) => `v1alarms@${alarmBook.toLowerCase()}`;

const MAX_VALUE = 130;
const show = (v: unknown): string => {
  const s = Array.isArray(v) ? v.join(",") : String(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s;
};

/** The v1 contracts emit events this file does not name (exits, payouts, registrations). Those are not for the ops chat. */
function decode(abi: typeof v1RouterAbi | typeof v1AlarmBookAbi, log: Log) {
  try {
    return decodeEventLog({ abi, data: log.data, topics: log.topics as never, strict: false });
  } catch (e) {
    if ((e as Error).name === "AbiEventSignatureNotFoundError") return null;
    throw e;
  }
}

function eventOf(contract: AdminContract, abi: typeof v1RouterAbi | typeof v1AlarmBookAbi, names: readonly string[], log: Log): AdminEvent | null {
  const ev = decode(abi, log);
  if (!ev || !names.includes(ev.eventName)) return null;
  const given = (ev.args ?? {}) as Record<string, unknown>;
  const item = (abi as readonly { type: string; name?: string; inputs?: readonly { name?: string }[] }[]).find((x) => x.type === "event" && x.name === ev.eventName);
  const inputs = (item?.inputs ?? []).map((i) => i.name ?? "");
  return {
    contract,
    event: ev.eventName,
    args: inputs.map((n) => [n, show(given[n])] as [string, string]),
    tx: log.transactionHash,
    logIndex: log.logIndex,
    block: log.blockNumber,
  };
}

/** A v1 admin event from the v1 router's logs, or null for any other event. */
export const v1RouterAdminEvent = (log: Log) => eventOf("ExitRouter v1", v1RouterAbi, V1_ROUTER_ADMIN, log);
/** A v1 watcher change from the v1 AlarmBook's logs, or null for any other event. */
export const v1AlarmAdminEvent = (log: Log) => eventOf("AlarmBook v1", v1AlarmBookAbi, ["WatcherSet"], log);

export interface V1Arm { posId: Hex; owner: string; target: string; adapter: string; tx: Hex | null; logIndex: number | null; block: bigint | null }

/** A new arm on the v1 router, or null for any other log. */
export function v1ArmOf(log: Log): V1Arm | null {
  const ev = decode(v1RouterAbi, log);
  if (!ev || ev.eventName !== "Armed") return null;
  const a = ev.args as unknown as { posId: Hex; owner: string; target: string; adapter: string };
  return { posId: a.posId, owner: a.owner, target: a.target, adapter: a.adapter, tx: log.transactionHash, logIndex: log.logIndex, block: log.blockNumber };
}

/** One id per arm log, so a replayed log queues one alert. */
export const v1ArmAlertId = (a: V1Arm) => `v1arm:${a.tx}:${a.logIndex}`;

/** The operator message for a v1 arm: v1 has no keeper any more, so this position is only safe if its owner exits by hand. */
export function v1ArmText(chainId: number, a: V1Arm): string {
  const link = txUrl(chainId, a.tx);
  return [
    `Canopy ops: a new position was armed on the v1 ExitRouter${a.block === null ? "" : ` in block ${a.block}`}. No keeper runs for v1, so an alarm will not exit it.`,
    `Position: ${a.posId}. Owner: ${a.owner}. Vault: ${a.target}.`,
    link ? `Transaction: ${link}` : `Transaction: ${a.tx ?? "unknown"}`,
    "Tell the owner to arm on v2, or to exit by hand.",
  ].join("\n");
}

/** What the v1 router reader does with a log: admin events and arms go to the ops chat, everything else is ignored. */
export async function applyV1RouterLog(chainId: number, log: Log, ops: (id: string, text: string) => Promise<unknown>) {
  const admin = v1RouterAdminEvent(log);
  if (admin) return void (await ops(adminAlertId(admin), adminAlertText(chainId, admin)));
  const arm = v1ArmOf(log);
  if (arm) await ops(v1ArmAlertId(arm), v1ArmText(chainId, arm));
}

/** What the v1 AlarmBook reader does with a log: a watcher change goes to the ops chat, everything else is ignored. */
export async function applyV1AlarmLog(chainId: number, log: Log, ops: (id: string, text: string) => Promise<unknown>) {
  const admin = v1AlarmAdminEvent(log);
  if (admin) await ops(adminAlertId(admin), adminAlertText(chainId, admin));
}
