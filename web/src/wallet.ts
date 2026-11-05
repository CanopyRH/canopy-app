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

export type WalletChoice = { use: Eip1193 } | { pick: FoundWallet[]; phone: boolean } | { phoneOnly: true } | null;

/**
 * One wallet connects straight away, several need a choice, and a wallet too old to announce itself still works.
 * With WalletConnect on (`phone`), a phone wallet is always one of the choices, and the only one when nothing is installed.
 */
export function walletChoice(found: FoundWallet[], legacy?: Eip1193, phone = false): WalletChoice {
  const list = found.length || !legacy ? found : [{ info: { uuid: "legacy", name: COPY.browserWallet, icon: "" }, provider: legacy }];
  if (phone) return list.length ? { pick: list, phone } : { phoneOnly: true };
  if (list.length > 1) return { pick: list, phone };
  return list[0] ? { use: list[0].provider } : null;
}

/** A wallet supplies its own icon. Only an inline image is shown, so listing wallets contacts no outside server. */
export const safeIcon = (icon: string) => (/^data:image\//.test(icon) ? icon : null);

export interface Network { chainHex: string; chainName: string; rpcUrl: string; explorer: string }

/**
 * A wallet on the wrong network would send the same call to a different chain, so this checks before every transaction.
 * Most wallets don't ship with Robinhood Chain, so a wallet that can't switch is asked to add it.
 */
export async function ensureChain(w: Eip1193, n: Network) {
  const same = async () => parseInt((await w.request({ method: "eth_chainId" })) as string, 16) === parseInt(n.chainHex, 16);
  if (await same()) return;
  const switched = await w.request({ method: "wallet_switchEthereumChain", params: [{ chainId: n.chainHex }] }).then(() => true, (e: { code?: number }) => e?.code === 4001 ? null : false);
  if (switched === false && !(await same())) {
    await w.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: n.chainHex, chainName: n.chainName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [n.rpcUrl], blockExplorerUrls: [n.explorer] }],
    }).catch(() => {});
  }
  if (!(await same())) throw new Error(COPY.wrongChain);
}

/** Sends one transaction and waits for it. A later step can depend on it, and a revert never reads as success. */
export async function sendTx(w: Eip1193, receipts: Receipts, from: Address, tx: Tx, network: Network): Promise<Hex> {
  await ensureChain(w, network);
  const hash = (await w.request({ method: "eth_sendTransaction", params: [{ from, to: tx.to, data: tx.data }] })) as Hex;
  // A speed-up is fine. A cancel or a swap for another transaction means this one never ran, whatever the receipt says.
  let replaced = false;
  const receipt = await receipts.waitForTransactionReceipt({ hash, onReplaced: (r) => void (replaced = r.reason !== "repriced") });
  if (replaced || receipt.status !== "success") throw new Error(COPY.txFailed);
  return hash;
}

/** Plain words for a wallet error. */
export function friendly(e: unknown): string {
  const err = e as { code?: number; message?: string };
  if (err?.code === 4001 || /user (rejected|denied|cancel)/i.test(err?.message ?? "")) return COPY.txRejected;
  return (err?.message ?? COPY.txFailed).split("\n")[0]!.slice(0, 160);
}
