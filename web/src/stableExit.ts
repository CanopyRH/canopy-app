import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import type { Chain } from "./config";

export interface SwapLeg {
  token: Address;
  feed: Address;
  heartbeat: number;
  tokenDecimals: number;
  path: Hex;
}
export interface ReviewedRoute extends SwapLeg {
  reviewUrl: string;
  reviewedAt: string;
}
export interface Payout {
  harbour: number;
  maxSlipBps: number;
  swaps: SwapLeg[];
}
export const RAW_PAYOUT: Payout = { harbour: 0, maxSlipBps: 0, swaps: [] };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Only repository-reviewed routes can enter a preset. A server cannot supply a feed, path or recipient. */
export function validRoute(route: ReviewedRoute, stable: Address): boolean {
  if (
    ![route.token, route.feed, stable].every(
      (a) => isAddress(a, { strict: false }) && !same(a, zeroAddress),
    )
  )
    return false;
  if (
    !Number.isInteger(route.heartbeat) ||
    route.heartbeat < 1 ||
    route.heartbeat > 172800
  )
    return false;
  if (
    !Number.isInteger(route.tokenDecimals) ||
    route.tokenDecimals < 0 ||
    route.tokenDecimals > 36
  )
    return false;
  if (
    !/^https:\/\//.test(route.reviewUrl) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(route.reviewedAt)
  )
    return false;
  if (!/^0x[0-9a-fA-F]+$/.test(route.path)) return false;
  const bytes = (route.path.length - 2) / 2;
  if (bytes < 43 || (bytes - 20) % 23 || bytes > 112) return false;
  if (
    !same(route.path.slice(0, 42), route.token) ||
    !same(`0x${route.path.slice(-40)}`, stable)
  )
    return false;
  // Reject zero-length fee tiers and zero-address hops.
  for (let offset = 42; offset < route.path.length; offset += 46) {
    const fee = Number.parseInt(route.path.slice(offset, offset + 6), 16);
    if (
      fee <= 0 ||
      fee >= 1_000_000 ||
      same(`0x${route.path.slice(offset + 6, offset + 46)}`, zeroAddress)
    )
      return false;
  }
  return true;
}

/** null means at least one output lacks a reviewed route. Stablecoin-only exits need no swap. */
export function stablePayout(
  c: Pick<Chain, "planToken" | "stableRoutes">,
  outputTokens: readonly Address[],
  slipBps = 100,
): Payout | null {
  if (!Number.isInteger(slipBps) || slipBps < 0 || slipBps > 100)
    throw new Error("Choose slippage from 0 to 100 basis points.");
  const tokens = [
    ...new Set(outputTokens.map((t) => t.toLowerCase() as Address)),
  ];
  if (!tokens.length || tokens.length > 4) return null;
  const swaps: SwapLeg[] = [];
  for (const token of tokens) {
    if (same(token, c.planToken)) continue;
    const matches = (c.stableRoutes ?? []).filter((r) => same(r.token, token));
    if (matches.length !== 1 || !validRoute(matches[0]!, c.planToken))
      return null;
    const { feed, heartbeat, tokenDecimals, path } = matches[0]!;
    swaps.push({ token, feed, heartbeat, tokenDecimals, path });
  }
  return { harbour: 1, maxSlipBps: slipBps, swaps };
}
