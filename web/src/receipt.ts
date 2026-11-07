import { createPublicClient, formatUnits, http, isHex, parseAbi, parseEventLogs, type Address, type Hex, type Log, type PublicClient } from "viem";
import { CHAINS, CONFIG, type Chain } from "./config";
import { Kind, presetsFor } from "../../services/src/api/presets";
import { routerAbi } from "../../services/src/chain/abi.generated";

/** Everything on an exit receipt comes from the chain. Nothing here calls Canopy's API, so a receipt works while Canopy is down. */

export const routerEvents = parseAbi([
  "event Exited(uint256 indexed exitId, bytes32 indexed posId, address indexed owner, address caller, bytes32 alarmKey, bool viaAlarm)",
  "event Paid(uint256 indexed exitId, address indexed owner, address token, uint256 amount, bool swapped)",
  "event Owed(address indexed owner, address indexed token, uint256 amount)",
]);
const readAbi = parseAbi([
  "function detector(bytes32) view returns ((uint8 kind, address target, uint256 threshold, uint32 window, bytes32 a, bytes32 b))",
  "function state(bytes32) view returns (bool exists, uint64 firedAt, uint64 snapAt, uint256 baseline, uint256 snap)",
  "event Fired(bytes32 indexed key, uint8 kind, address indexed target, address by, bytes32 evidence)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
]);

export interface Exit { exitId: bigint; posId: Hex; owner: Address; alarmKey: Hex; viaAlarm: boolean }
export interface Payout { token: Address; amount: bigint; swapped: boolean; held: boolean }

/** The Canopy exits in one transaction's logs, each with what was paid out or held for the owner. Logs from other contracts are ignored. */
export function decodeExits(logs: readonly Log[], router: Address): { exit: Exit; payouts: Payout[] }[] {
  const mine = logs.filter((l) => l.address.toLowerCase() === router.toLowerCase());
  const parsed = parseEventLogs({ abi: routerEvents, logs: mine as Log[], strict: false });
  const exits: { exit: Exit; payouts: Payout[] }[] = [];
  for (const l of parsed) {
    if (l.eventName !== "Exited" || !l.args.exitId || !l.args.posId || !l.args.owner || !l.args.alarmKey) continue;
    const { exitId, posId, owner, alarmKey, viaAlarm } = l.args;
    exits.push({ exit: { exitId, posId, owner, alarmKey, viaAlarm: Boolean(viaAlarm) }, payouts: [] });
  }
  for (const l of parsed) {
    if (l.eventName === "Paid" && l.args.token && l.args.amount !== undefined) {
      const e = exits.find((x) => x.exit.exitId === l.args.exitId);
      e?.payouts.push({ token: l.args.token, amount: l.args.amount, swapped: Boolean(l.args.swapped), held: false });
    }
    // Owed has no exit id, so it goes to the first exit for the same owner.
    if (l.eventName === "Owed" && l.args.token && l.args.amount !== undefined) {
      exits.find((x) => x.exit.owner === l.args.owner)?.payouts.push({ token: l.args.token, amount: l.args.amount, held: true, swapped: false });
    }
  }
  return exits;
}

export type Fragment = { kind: "none" } | { kind: "bad"; text: string } | { kind: "ok"; hash: Hex; chain: Chain };

/**
 * Reads `receipt.html#0x<txhash>`, which is the first network's, or `receipt.html#<network>:0x<txhash>` for another one
 * (`receipt.html#base:0x...`). A leading `#/` is tolerated. A network the app does not have is refused, not guessed.
 */
export function parseFragment(fragment: string, list: readonly Chain[] = CHAINS): Fragment {
  const text = decodeURIComponent(fragment.replace(/^#\/?/, "")).trim();
  if (!text) return { kind: "none" };
  const at = text.indexOf(":");
  const chain = at < 0 ? list[0] : list.find((c) => c.key === text.slice(0, at).toLowerCase());
  const hash = at < 0 ? text : text.slice(at + 1);
  return chain && /^0x[0-9a-fA-F]{64}$/.test(hash) && isHex(hash) ? { kind: "ok", hash: hash.toLowerCase() as Hex, chain } : { kind: "bad", text: text.slice(0, 80) };
}

/** The link to one exit's receipt. The first network's links stay as they were; any other names its network. */
export function receiptLink(chain: Chain, hash: Hex, list: readonly Chain[] = CHAINS): string {
  return `receipt.html#${chain.key === list[0]?.key ? "" : chain.key + ":"}${hash}`;
}

const KIND_NAMES: Record<number, string> = {
  [Kind.PRICE_BELOW]: "Price fell below a set level",
  [Kind.SHARE_DROP]: "Vault share price dropped",
  [Kind.PAUSED]: "Vault paused",
  [Kind.ADDRESS_CHANGE]: "A watched address changed",
  [Kind.DRAIN]: "Vault drain",
  [Kind.QUORUM]: "Exploit confirmed by watchers",
  [Kind.BOTH]: "Two alarms together",
};

/** Plain name for an alarm: Canopy's own preset when the key matches one for this vault, else the kind of alarm. */
export function alarmName(key: Hex, kind: number | null, vault: Address | null): string {
  if (vault) {
    const hit = presetsFor(vault).find((p) => p.key === key) ?? presetsFor(vault).flatMap((p) => p.requires ?? []).find((p) => p.key === key);
    if (hit) return hit.name;
  }
  return kind === null ? "Custom alarm" : (KIND_NAMES[kind] ?? "Custom alarm");
}

/** "2 seconds", "4 minutes", "1 hour 5 minutes". */
export function formatDelay(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return "the same second";
  const plural = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"}`;
  if (s < 60) return plural(s, "second");
  if (s < 3600) return plural(Math.round(s / 60), "minute");
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m === 0 ? plural(h, "hour") : `${plural(h, "hour")} ${plural(m, "minute")}`;
}

/** Token amount with its decimals applied, grouped, with trailing zeros dropped past two places. */
export function formatAmount(amount: bigint, decimals: number): string {
  const [whole = "0", frac = ""] = formatUnits(amount, decimals).split(".");
  const f = frac.replace(/0+$/, "");
  const g = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (amount > 0n && whole === "0" && f.length > 8 && /^0{8}/.test(f)) return "< 0.00000001";
  return f.length > 8 ? `${g}.${f.slice(0, 8)}` : f.length >= 2 ? `${g}.${f}` : `${g}.${f.padEnd(2, "0")}`;
}

export interface TokenInfo { address: Address; symbol: string; decimals: number }
export interface Receipt {
  hash: Hex;
  blockNumber: bigint;
  blockTime: number;
  explorerUrl: string;
  exitId: bigint;
  owner: Address;
  viaAlarm: boolean;
  vault: Address | null;
  vaultName: string | null;
  alarm: { key: Hex; name: string } | null;
  firedAt: number | null;
  delaySeconds: number | null;
  payouts: { token: TokenInfo; amount: bigint; swapped: boolean; held: boolean; text: string }[];
}

export class ReceiptError extends Error {
  constructor(readonly code: "pending" | "missing" | "failed" | "not-exit" | "rpc" | "unset") { super(code); }
}

const clientFor = (c: Chain): PublicClient => createPublicClient({ transport: http(c.rpcUrl) }) as PublicClient;

async function tokenInfo(c: PublicClient, address: Address): Promise<TokenInfo> {
  const [symbol, decimals] = await Promise.all([
    c.readContract({ address, abi: readAbi, functionName: "symbol" }).catch(() => "tokens"),
    c.readContract({ address, abi: readAbi, functionName: "decimals" }).catch(() => 18),
  ]);
  return { address, symbol: String(symbol), decimals: Number(decimals) };
}

/** Reads one exit transaction. Throws ReceiptError with a code the page turns into plain words. */
export async function loadReceipt(hash: Hex, chain: Chain = CONFIG, client: PublicClient = clientFor(chain)): Promise<Receipt> {
  const router = chain.router, book = chain.alarmBook;
  if (!router || !book) throw new ReceiptError("unset");
  let rc;
  try {
    rc = await client.getTransactionReceipt({ hash });
  } catch (e) {
    const name = (e as { name?: string }).name ?? "";
    if (name !== "TransactionReceiptNotFoundError") throw new ReceiptError("rpc");
    try {
      const tx = await client.getTransaction({ hash });
      throw new ReceiptError(tx.blockNumber === null ? "pending" : "rpc");
    } catch (e2) {
      if (e2 instanceof ReceiptError) throw e2;
      throw new ReceiptError((e2 as { name?: string }).name === "TransactionNotFoundError" ? "missing" : "rpc");
    }
  }
  if (rc.status !== "success") throw new ReceiptError("failed");
  const found = decodeExits(rc.logs, router)[0];
  if (!found) throw new ReceiptError("not-exit");
  const { exit, payouts } = found;
  try {
    const block = await client.getBlock({ blockNumber: rc.blockNumber });
    const blockTime = Number(block.timestamp);
    const pos = await client.readContract({ address: router, abi: routerAbi, functionName: "positions", args: [exit.posId], blockNumber: rc.blockNumber }).catch(() => null);
    const vault = pos ? pos[7] : null;
    const zero = /^0x0+$/.test(exit.alarmKey);
    let alarm: Receipt["alarm"] = null, firedAt: number | null = null;
    if (exit.viaAlarm && !zero) {
      const [det, st] = await Promise.all([
        client.readContract({ address: book, abi: readAbi, functionName: "detector", args: [exit.alarmKey] }).catch(() => null),
        client.readContract({ address: book, abi: readAbi, functionName: "state", args: [exit.alarmKey] }).catch(() => null),
      ]);
      alarm = { key: exit.alarmKey, name: alarmName(exit.alarmKey, det ? Number(det.kind) : null, vault) };
      if (st && Number(st[1]) > 0 && Number(st[1]) <= blockTime) firedAt = Number(st[1]);
      else {
        // The alarm fired again after this exit, so the stored time is newer. Find the fire that came before it.
        const logs = await client.getLogs({ address: book, event: readAbi[2], args: { key: exit.alarmKey }, fromBlock: rc.blockNumber > 10_000_000n ? rc.blockNumber - 10_000_000n : 0n, toBlock: rc.blockNumber }).catch(() => []);
        const last = logs[logs.length - 1];
        if (last) firedAt = Number((await client.getBlock({ blockNumber: last.blockNumber })).timestamp);
      }
    }
    const tokens = new Map<string, TokenInfo>();
    await Promise.all([...new Set(payouts.map((p) => p.token))].map(async (t) => void tokens.set(t, await tokenInfo(client, t))));
    const vaultName = vault ? (chain.vaults.find((v) => v.address.toLowerCase() === vault.toLowerCase())?.name ?? (await client.readContract({ address: vault, abi: readAbi, functionName: "name" }).catch(() => null))) : null;
    return {
      hash, blockNumber: rc.blockNumber, blockTime, explorerUrl: `${chain.explorer}/tx/${hash}`,
      exitId: exit.exitId, owner: exit.owner, viaAlarm: exit.viaAlarm, vault, vaultName, alarm, firedAt,
      delaySeconds: firedAt === null ? null : blockTime - firedAt,
      payouts: payouts.map((p) => { const token = tokens.get(p.token)!; return { ...p, token, text: `${formatAmount(p.amount, token.decimals)} ${token.symbol}` }; }),
    };
  } catch {
    throw new ReceiptError("rpc");
  }
}
