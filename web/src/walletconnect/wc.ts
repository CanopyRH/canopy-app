/**
 * Built on its own as wc.js. Opens the WalletConnect QR code (or the wallet list on a phone) and returns the connected wallet.
 * WalletConnect: Portions © 2025 Reown, Inc. All Rights Reserved. Used under the WalletConnect Community License (licenses/walletconnect.md).
 */
import { EthereumProvider } from "@walletconnect/ethereum-provider";
import type { OpenWalletConnect } from "./load";

/**
 * Robinhood Wallet's WalletConnect registry entry, featured first. Its listing (checked 2026-11-05) doesn't name
 * Robinhood Chain yet, so without this the list hides the chain's own wallet, though the wallet does connect on 4663.
 */
const ROBINHOOD_WALLET = "8837dd9413b1d9b585ee937d27a816590248386d9dbf59f5cd3422dbbb65683e";

const open: OpenWalletConnect = async (o) => {
  const provider = await EthereumProvider.init({
    projectId: o.projectId,
    // optionalChains, not chains: smart-contract wallets refuse a session that demands a chain up front.
    optionalChains: [o.chainId],
    rpcMap: { [o.chainId]: o.rpcUrl },
    showQrModal: true,
    qrModalOptions: { explorerRecommendedWalletIds: [ROBINHOOD_WALLET] },
    metadata: { name: "Canopy", description: o.description, url: location.origin, icons: [new URL("icon-192.png", location.href).href] },
  });
  if (!provider.session) await provider.connect();
  return provider;
};

(window as { canopyWalletConnect?: OpenWalletConnect }).canopyWalletConnect = open;
