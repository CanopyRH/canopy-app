import type { Address } from "viem";
import { CONFIG } from "../../config";

/** One move as GET /whales sends it. The wallet is already shortened by the API. */
export interface WhaleMove {
  vault: string;
  vaultName: string | null;
  direction: "in" | "out";
  asset: string;
  usd: number;
  label: string;
  pctOfVault: number;
  liquidUsd: number | null;
  wallet: string;
  tx: string;
  txUrl: string | null;
  at: number;
}

/** Recent moves on one vault, newest first. Null when the API can't be reached. Only the vault is sent, never a wallet. */
export async function fetchWhales(vault: Address, limit = 5, base = CONFIG.apiUrl, doFetch: typeof fetch = fetch): Promise<WhaleMove[] | null> {
  try {
    const res = await doFetch(`${base}/whales?vault=${vault}&limit=${limit}`);
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? body.filter(isMove) : null;
  } catch {
    return null;
  }
}

function isMove(x: unknown): x is WhaleMove {
  const m = x as Partial<WhaleMove> | null;
  return !!m && (m.direction === "in" || m.direction === "out") && typeof m.label === "string" && typeof m.pctOfVault === "number" && typeof m.at === "number" && typeof m.wallet === "string" && typeof m.tx === "string";
}

/** 4.1 as "4.1%", and a tiny share as "<0.1%". */
export const pct = (p: number) => (p <= 0 ? "0%" : p < 0.1 ? "<0.1%" : p >= 99.95 ? "100%" : `${p.toFixed(1)}%`);

/** Seconds since `at`, in a person's words. */
export function ago(at: number, now: number): string {
  const s = Math.max(0, now - at);
  if (s < 90) return "just now";
  if (s < 5_400) return `${Math.round(s / 60)}m ago`;
  if (s < 129_600) return `${Math.round(s / 3_600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
