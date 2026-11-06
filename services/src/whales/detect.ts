import { parseAbi } from "viem";
import type { WhaleConfig } from "./config";

/** The ERC-4626 events. `owner` is the wallet whose shares moved, whoever sent the transaction. */
export const whaleEvents = parseAbi([
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
]);

export type Direction = "in" | "out";

export interface Sized { usdCents: bigint; pctBps: number; barCents: bigint; whale: boolean }

/** Dollars a move is worth, in cents, for an asset worth one dollar a unit. */
export const usdCentsOf = (assets: bigint, decimals: number) => (assets * 100n) / 10n ** BigInt(decimals);

/**
 * Whether one move is a whale move. The bar is the larger of WHALE_MIN_USD and WHALE_MIN_PCT of the vault; a move at the
 * bar counts. The vault's size is what it held with the move in it: after a deposit, before a withdrawal. So "4.1% of the
 * vault" means 4.1% of what it held while the money was in. `totalAfter` is totalAssets read at the move's block.
 */
export function sizeMove(c: Pick<WhaleConfig, "minUsd" | "minPct">, m: { dir: Direction; assets: bigint; totalAfter: bigint; decimals: number }): Sized {
  const vault = m.dir === "out" ? m.totalAfter + m.assets : m.totalAfter;
  const usdCents = usdCentsOf(m.assets, m.decimals);
  const vaultCents = usdCentsOf(vault, m.decimals);
  const minCents = BigInt(Math.round(c.minUsd * 100));
  const pctCents = (vaultCents * BigInt(Math.round(c.minPct * 100))) / 10_000n; // percent in basis points: 2.5% is 250
  const barCents = pctCents > minCents ? pctCents : minCents;
  const pctBps = vault > 0n ? Number((m.assets * 10_000n) / vault) : 0;
  return { usdCents, pctBps: Math.min(pctBps, 10_000), barCents, whale: m.assets > 0n && usdCents >= barCents };
}
