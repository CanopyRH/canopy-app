import type { Address, Hex } from "viem";
import { COPY } from "./copy/text";
import type { Tx } from "./tx";

export interface Eip1193 { request(a: { method: string; params?: unknown[] }): Promise<unknown> }
export interface Receipts {
  waitForTransactionReceipt(a: { hash: Hex; onReplaced?: (r: { reason: string }) => void }): Promise<{ status: string }>;
}

export interface FoundWallet { info: { uuid: string; name: string; icon: string }; provider: Eip1193 }

/** Hears every installed wallet (EIP-6963), so two wallets can't hide each other behind window.ethereum. */
export function watchWallets(page: EventTarget, onChange: (all: FoundWallet[]) => void) {
  const found = new Map<string, FoundWallet>();
  page.addEventListener("eip6963:announceProvider", (e) => {
    const d = (e as CustomEvent<Partial<FoundWallet> | undefined>).detail;
    if (!d?.info?.uuid || !d.info.name || typeof d.provider?.request !== "function") return;
    found.set(d.info.uuid, d as FoundWallet);
    onChange([...found.values()]);
  });
  page.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** One wallet connects straight away, several need a choice, and a wallet too old to announce itself still works. */
export function walletChoice(found: FoundWallet[], legacy?: Eip1193): { use: Eip1193 } | { pick: FoundWallet[] } | null {
  if (found.length > 1) return { pick: found };
  const only = found[0]?.provider ?? legacy;
  return only ? { use: only } : null;
}

/** A wallet supplies its own icon. Only an inline image is shown, so listing wallets contacts no outside server. */
export const safeIcon = (icon: string) => (/^data:image\//.test(icon) ? icon : null);

export interface Network { chainHex: string; chainName: string; rpcUrl: string; explorer: string }
