import type { Address } from "viem";

import deployment from "./deployment.json";
import mainnet from "./mainnet.json";

export interface Vault { address: Address; name: string; asset: string }

/** Mainnet defaults. mainnet.json holds the launch addresses, and deployment.json overrides both for a test deployment. With no contracts set, the app is scan-only. */
const DEFAULTS = {
  chainId: 4663,
  chainHex: "0x1237",
  chainName: "Robinhood Chain",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  apiUrl: "",
  router: null as Address | null,
  adapter: null as Address | null,
  alarmBook: null as Address | null,
  planPayTo: null as Address | null,
  planToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address, // USDG
  // Reown project ID. It is public by design; with none set, the app offers browser wallets only.
  walletConnectProjectId: null as string | null,
  // USDG vaults whose curators gave up every share gate, with none set. Checked on-chain 2026-11-03.
  vaults: [
    { address: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd", name: "Steakhouse USDG", asset: "USDG" },
    { address: "0xBEEff039907422219Fb367e525954DDC092854d9", name: "Grove x Steakhouse USDG", asset: "USDG" },
    { address: "0xd0dACE70434fF7567b108B5a8c2a36C150C830FE", name: "Galaxy USDG RH Stock Tokens", asset: "USDG" },
    { address: "0x8c258F25fc6fBe3f01ccC828E2C3840A46a4a9A2", name: "Yearn Stonk USDG", asset: "USDG" },
    { address: "0x37788ff0c1d4e45A7FE06BC7e71e0cc00121d0A8", name: "Purinta USDG", asset: "USDG" },
  ] satisfies Vault[],
};

export const CONFIG = { ...DEFAULTS, ...(mainnet as Partial<typeof DEFAULTS>), ...(deployment as Partial<typeof DEFAULTS>) };
