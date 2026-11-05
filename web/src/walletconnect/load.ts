import { COPY } from "../copy/text";
import type { Chain } from "../config";
import type { Eip1193 } from "../wallet";

/** chainId is the network the app has selected. `more` lists the other networks it offers, so the wallet can switch to them later. */
export interface WalletConnectOptions { projectId: string; chainId: number; rpcUrl: string; description: string; more?: { chainId: number; rpcUrl: string }[] }
export type PhoneWallet = Eip1193 & { on?(event: string, fn: () => void): void };
export type OpenWalletConnect = (o: WalletConnectOptions) => Promise<PhoneWallet>;

/** The selected network first, then every other one the app offers. */
export function phoneOptions(selected: Chain, offered: Chain[], description: string): WalletConnectOptions {
  return {
    projectId: selected.walletConnectProjectId!,
    chainId: selected.chainId,
    rpcUrl: selected.rpcUrl,
    description,
    more: offered.filter((c) => c.chainId !== selected.chainId).map(({ chainId, rpcUrl }) => ({ chainId, rpcUrl })),
  };
}

type Host = { canopyWalletConnect?: OpenWalletConnect };
let loading: Promise<OpenWalletConnect> | null = null;

/**
 * WalletConnect is a large bundle, so it is its own script (wc.js) and loads only when someone picks a phone wallet.
 * A failed load can be retried.
 */
export function loadWalletConnect(doc: Document = document, host: Host = window as Host): Promise<OpenWalletConnect> {
  loading ??= new Promise<OpenWalletConnect>((resolve, reject) => {
    const fail = () => ((loading = null), reject(new Error(COPY.phoneWalletFailed)));
    const s = doc.createElement("script");
    s.src = "wc.js";
    s.type = "module"; // the bundle uses import.meta
    s.async = true;
    s.onload = () => (host.canopyWalletConnect ? resolve(host.canopyWalletConnect) : fail());
    s.onerror = fail;
    doc.head.appendChild(s);
  });
  return loading;
}
