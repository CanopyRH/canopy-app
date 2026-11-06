import { createPublicClient, http, parseAbi, parseEventLogs, type Address, type Log, type PublicClient } from "viem";
import type { Chain } from "./config";
import { LIMITS_COPY } from "./copy/limits";

/**
 * The limits page reads everything from the chain: the router, its Timelock and the AlarmBook. Nothing here calls Canopy's
 * API. Each fact is read on its own, so one failed read marks that fact as unread and leaves the others standing.
 */

export const DAY = 86_400;

export type Fact<T> = { ok: true; value: T } | { ok: false };
const ok = <T>(value: T): Fact<T> => ({ ok: true, value });
const unread = { ok: false } as const;
async function attempt<T>(f: () => Promise<T>): Promise<Fact<T>> {
  try {
    return ok(await f());
  } catch {
    return unread;
  }
}

const routerAbi = parseAbi([
  "function ADMIN_EXPIRY() view returns (uint256)",
  "function ADMIN() view returns (address)",
  "function guardian() view returns (address)",
  "function armingPaused() view returns (bool)",
  "function adapterAllowed(address) view returns (bool)",
  "event AdapterSet(address indexed adapter, bool allowed)",
]);
const bookAbi = parseAbi([
  "function ADMIN() view returns (address)",
  "function watcherSince(address) view returns (uint64)",
  "function watcherUntil(address) view returns (uint64)",
  "event WatcherSet(address indexed watcher, uint64 since, uint64 until)",
]);
const timelockAbi = parseAbi(["function PROPOSER() view returns (address)", "function DELAY() view returns (uint256)"]);

// ------------------------------------------------------------------ countdown

export interface Countdown { ended: boolean; seconds: number; days: number; hours: number; minutes: number }

/** Time from `now` to `expiry`, in whole units (rounded down, so it never promises more time than there is). Both are Unix seconds. */
export function countdown(expiry: number, now: number): Countdown {
  const left = Math.max(0, Math.floor(expiry - now));
  return { ended: left === 0, seconds: left, days: Math.floor(left / DAY), hours: Math.floor((left % DAY) / 3600), minutes: Math.floor((left % 3600) / 60) };
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** "Admin powers end in 363 days", or in hours or minutes inside the last day. */
export function headline(c: Countdown): string {
  if (c.ended) return "Admin powers have ended";
  if (c.days >= 1) return `Admin powers end in ${plural(c.days, "day")}`;
  if (c.hours >= 1) return `Admin powers end in ${plural(c.hours, "hour")}`;
  return c.minutes >= 1 ? `Admin powers end in ${plural(c.minutes, "minute")}` : "Admin powers end in less than a minute";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "4 November 2027, 00:00 UTC". Built by hand so every browser prints the same words. */
export function utcDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** The short form for tables: "6 Nov 2026". */
export function utcDay(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.slice(0, 3)} ${d.getUTCFullYear()}`;
}

/** The post text for the countdown. Under a day it says so, and after the date it speaks in the past tense. */
export function tweetText(c: Countdown): string {
  if (c.ended) return LIMITS_COPY.tweet.ended;
  return c.days >= 1 ? LIMITS_COPY.tweet.days(c.days) : LIMITS_COPY.tweet.soon;
}

export const tweetUrl = (text: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`;

/** The Timelock delay in words. */
export function delayText(seconds: number): string {
  if (seconds === 0) return "None";
  if (seconds % DAY === 0) return plural(seconds / DAY, "day");
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  return plural(Math.round(seconds / 60), "minute");
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ------------------------------------------------------------------ events

export interface AdapterRow { adapter: Address; allowed: boolean }

/**
 * Turns the router's AdapterSet logs into one row per adapter, in the order each first appeared, with the last word on whether
 * it is allowed. Logs may arrive in any order. Logs from other contracts or other events are ignored.
 */
export function parseAdapterLogs(logs: readonly Log[], router: Address): AdapterRow[] {
  const mine = logs.filter((l) => l.address.toLowerCase() === router.toLowerCase());
  const parsed = parseEventLogs({ abi: routerAbi, logs: mine as Log[], eventName: "AdapterSet", strict: false });
  const ordered = parsed
    .filter((l) => l.args.adapter !== undefined && l.args.allowed !== undefined)
    .sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
  const rows = new Map<string, AdapterRow>();
  for (const l of ordered) {
    const key = l.args.adapter!.toLowerCase();
    rows.set(key, { adapter: l.args.adapter!, allowed: Boolean(l.args.allowed) });
  }
  return [...rows.values()];
}

/** The watchers named in WatcherSet logs, once each, in the order they first appeared. Their current terms are read separately. */
export function parseWatcherLogs(logs: readonly Log[], book: Address): Address[] {
  const mine = logs.filter((l) => l.address.toLowerCase() === book.toLowerCase());
  const parsed = parseEventLogs({ abi: bookAbi, logs: mine as Log[], eventName: "WatcherSet", strict: false });
  const ordered = parsed
    .filter((l) => l.args.watcher !== undefined)
    .sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
  const seen = new Map<string, Address>();
  for (const l of ordered) if (!seen.has(l.args.watcher!.toLowerCase())) seen.set(l.args.watcher!.toLowerCase(), l.args.watcher!);
  return [...seen.values()];
}

export type WatcherState = "waiting" | "active" | "expired";
export interface WatcherRow { watcher: Address; since: number; until: number }

/** Before its start a watcher is waiting, inside its term it is active, and at the end time (exclusive) it has expired. */
export function watcherState(w: Pick<WatcherRow, "since" | "until">, now: number): WatcherState {
  return now < w.since ? "waiting" : now < w.until ? "active" : "expired";
}

/** Approvals as the contract stores them: since 0 means removed. Removed watchers are left out; the rest are sorted by start, keeping the order of the events for equal starts. */
export function watcherRows(reads: { watcher: Address; since: bigint; until: bigint }[]): WatcherRow[] {
  return reads
    .filter((r) => r.since !== 0n)
    .map((r) => ({ watcher: r.watcher, since: Number(r.since), until: Number(r.until) }))
    .sort((a, b) => a.since - b.since);
}

/**
 * Reads logs for a block range, splitting the range in two when the node refuses it, within a budget of requests.
 * Throws when the budget runs out, so a half-read history is never shown as the whole.
 */
export async function getLogsSplit(fetch: (from: bigint, to: bigint) => Promise<Log[]>, from: bigint, to: bigint, budget = { left: 48 }): Promise<Log[]> {
  if (from > to) return [];
  if (budget.left <= 0) throw new Error("log range too large");
  budget.left--;
  try {
    return await fetch(from, to);
  } catch (e) {
    if (from === to) throw e;
    const mid = from + (to - from) / 2n;
    const first = await getLogsSplit(fetch, from, mid, budget);
    return [...first, ...(await getLogsSplit(fetch, mid + 1n, to, budget))];
  }
}

// ------------------------------------------------------------------ the whole read

export interface Limits {
  chain: Chain;
  /** The chain's clock minus the browser's, in seconds, or null when the chain's time couldn't be read. */
  clockOffset: Fact<number>;
  expiry: Fact<number>;
  guardian: Fact<Address>;
  armingPaused: Fact<boolean>;
  admin: Fact<Address>;
  delay: Fact<number>;
  proposer: Fact<Address>;
  adapters: Fact<AdapterRow[]>;
  watcherAdmin: Fact<Address>;
  watchers: Fact<WatcherRow[]>;
}

const clientFor = (c: Chain): PublicClient => createPublicClient({ transport: http(c.rpcUrl) }) as PublicClient;

/** Reads every fact for one network. A fact that fails is marked unread; the rest still come back. */
export async function loadLimits(chain: Chain, nowSeconds: () => number = () => Math.floor(Date.now() / 1000), client: PublicClient = clientFor(chain)): Promise<Limits> {
  const router = chain.router, book = chain.alarmBook, from = chain.deployBlock;
  const read = <T>(address: Address, abi: unknown, functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const empty = { ok: false } as const;
  if (!router || !book) return { chain, clockOffset: empty, expiry: empty, guardian: empty, armingPaused: empty, admin: empty, delay: empty, proposer: empty, adapters: empty, watcherAdmin: empty, watchers: empty };

  const head = await attempt(() => client.getBlock());
  const admin = await attempt(() => read<Address>(router, routerAbi, "ADMIN"));
  const [expiry, guardian, armingPaused, watcherAdmin] = await Promise.all([
    attempt(async () => Number(await read<bigint>(router, routerAbi, "ADMIN_EXPIRY"))),
    attempt(() => read<Address>(router, routerAbi, "guardian")),
    attempt(() => read<boolean>(router, routerAbi, "armingPaused")),
    attempt(() => read<Address>(book, bookAbi, "ADMIN")),
  ]);
  const [delay, proposer] = admin.ok
    ? await Promise.all([
        attempt(async () => Number(await read<bigint>(admin.value, timelockAbi, "DELAY"))),
        attempt(() => read<Address>(admin.value, timelockAbi, "PROPOSER")),
      ])
    : [unread, unread];

  // Events run from the deploy block to the head. With either one unknown, the history can't be read, so the lists are unread.
  const range = head.ok && from !== null ? { from: BigInt(from), to: head.value.number } : null;
  const logs = (address: Address, event: (typeof routerAbi)[5] | (typeof bookAbi)[3]) =>
    range ? getLogsSplit((a, b) => client.getLogs({ address, event, fromBlock: a, toBlock: b }) as Promise<Log[]>, range.from, range.to) : Promise.reject(new Error("no range"));

  const adapters = await attempt(async () => {
    const rows = parseAdapterLogs(await logs(router, routerAbi[5]), router);
    // The mapping itself has the last word. An adapter whose read fails keeps the answer its events gave.
    return Promise.all(rows.map(async (r) => ({ adapter: r.adapter, allowed: await read<boolean>(router, routerAbi, "adapterAllowed", [r.adapter]).catch(() => r.allowed) })));
  });
  const watchers = await attempt(async () => {
    const names = parseWatcherLogs(await logs(book, bookAbi[3]), book);
    const reads = await Promise.all(
      names.map(async (watcher) => ({
        watcher,
        since: await read<bigint>(book, bookAbi, "watcherSince", [watcher]),
        until: await read<bigint>(book, bookAbi, "watcherUntil", [watcher]),
      })),
    );
    return watcherRows(reads);
  });

  return {
    chain,
    clockOffset: head.ok ? ok(Number(head.value.timestamp) - nowSeconds()) : unread,
    expiry, guardian, armingPaused, admin, delay, proposer, adapters, watcherAdmin, watchers,
  };
}

/** The current time in Unix seconds on the chain's clock, or the device's when the chain's couldn't be read. */
export function chainNow(limits: Pick<Limits, "clockOffset">, deviceSeconds: number): number {
  return deviceSeconds + (limits.clockOffset.ok ? limits.clockOffset.value : 0);
}

/** Link to an address on the chain's explorer. */
export const addressUrl = (chain: Chain, address: string) => `${chain.explorer}/address/${address}`;

/** Links to the verified source: the explorer's contract tab (Blockscout and Etherscan-style explorers differ) and Sourcify's page. */
export function sourceLinks(chain: Chain, address: Address): { explorerName: string; explorer: string; sourcify: string } {
  const blockscout = /blockscout/i.test(chain.explorer);
  return {
    explorerName: blockscout ? "Blockscout" : "Explorer",
    explorer: blockscout ? `${chain.explorer}/address/${address}?tab=contract` : `${chain.explorer}/address/${address}#code`,
    sourcify: `https://repo.sourcify.dev/${chain.chainId}/${address}`,
  };
}
