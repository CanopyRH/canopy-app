import { formatUnits, type Address } from "viem";
import { isBlocked, parseWallet } from "../../tx";

/** The saved-wallet list. Pure logic: no React and no chain reads, so it can be tested alone. It lives only in the browser's localStorage. */

export interface Saved { address: Address; label: string }

export const MAX_WALLETS = 10;
export const MAX_LABEL = 30;
export const STORAGE_KEY = "canopy.wallets.v1";

export type AddError = "bad" | "blocked" | "duplicate" | "full";
export type AddResult = { ok: true; list: Saved[] } | { ok: false; error: AddError };

/** The slice of localStorage this file uses, so tests can pass a stand-in. */
export interface Store { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export const sameAddress = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** One line, no control characters, trimmed and cut to length. */
export const cleanLabel = (s: unknown): string => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_LABEL).trim() : "");

export function addWallet(list: Saved[], input: string, label = ""): AddResult {
  const address = parseWallet(input);
  if (!address) return { ok: false, error: "bad" };
  if (isBlocked(address)) return { ok: false, error: "blocked" };
  if (list.some((w) => sameAddress(w.address, address))) return { ok: false, error: "duplicate" };
  if (list.length >= MAX_WALLETS) return { ok: false, error: "full" };
  return { ok: true, list: [...list, { address, label: cleanLabel(label) }] };
}

export const removeWallet = (list: Saved[], address: string): Saved[] => list.filter((w) => !sameAddress(w.address, address));

export const setLabel = (list: Saved[], address: string, label: string): Saved[] => list.map((w) => (sameAddress(w.address, address) ? { ...w, label: cleanLabel(label) } : w));

/** Keeps only entries that are still valid, so a damaged or hand-edited value can't break the app. */
export function parseList(raw: unknown): Saved[] {
  if (!Array.isArray(raw)) return [];
  let list: Saved[] = [];
  for (const item of raw) {
    const entry = item as { address?: unknown; label?: unknown } | null;
    const added = addWallet(list, typeof entry?.address === "string" ? entry.address : "", cleanLabel(entry?.label));
    if (added.ok) list = added.list;
  }
  return list;
}

/** Reaching `localStorage` can itself throw, for example when site data is blocked. */
export function defaultStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Every storage call is wrapped, because storage can be missing, full or blocked. Without it the list lasts until the page closes. */
export function loadList(store: Store | null = defaultStore()): Saved[] {
  try {
    const raw = store?.getItem(STORAGE_KEY);
    return raw ? parseList(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveList(list: Saved[], store: Store | null = defaultStore()): boolean {
  try {
    if (!store) return false;
    if (list.length) store.setItem(STORAGE_KEY, JSON.stringify(list));
    else store.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export type Shown = Saved & { saved: boolean; connected: boolean };

/** The wallets to show: the connected one first (saved or not), then the saved ones. Nobody appears twice. */
export function shown(saved: Saved[], connected: Address | null): Shown[] {
  const mine = connected ? saved.find((w) => sameAddress(w.address, connected)) : undefined;
  const head: Shown[] = connected ? [{ address: connected, label: mine?.label ?? "", saved: Boolean(mine), connected: true }] : [];
  return [...head, ...saved.filter((w) => !sameAddress(w.address, connected)).map((w) => ({ ...w, saved: true, connected: false }))];
}

export interface Reading { assets: bigint; armed: boolean }
export interface Totals { total: bigint; armed: bigint; positions: number }

/** One total across wallets. `readings` holds each shown wallet's positions, so a wallet is counted once. */
export function totals(readings: Reading[][]): Totals {
  const flat = readings.flat();
  return {
    total: flat.reduce((s, r) => s + r.assets, 0n),
    armed: flat.filter((r) => r.armed).reduce((s, r) => s + r.assets, 0n),
    positions: flat.length,
  };
}

/** Amounts are 6-decimal stablecoins on every listed vault. */
export const formatUsd = (v: bigint) => Number(formatUnits(v, 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
