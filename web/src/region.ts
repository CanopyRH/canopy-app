import type { Vault } from "./config";

/**
 * Assets that are Stock Tokens, by symbol or address (compared in lowercase). Empty today: every launch vault holds USDG
 * or USDC. Add an entry here when a vault whose asset is a Stock Token is listed, and its risk card shows the notice.
 */
export const STOCK_TOKEN_ASSETS: readonly string[] = [];

export type RegionKind = "stock" | "perps";

export function isStockToken(vault: Pick<Vault, "asset">, list: readonly string[] = STOCK_TOKEN_ASSETS): boolean {
  const a = vault.asset.toLowerCase();
  return list.some((x) => x.toLowerCase() === a);
}

/** Which region notices a vault needs. No location is read: the notice only tells people what may apply to them. */
export function regionNoticesFor(vault: Pick<Vault, "asset">, list: readonly string[] = STOCK_TOKEN_ASSETS): RegionKind[] {
  return isStockToken(vault, list) ? ["stock"] : [];
}
