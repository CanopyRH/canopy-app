import type { Address } from "viem";
import type { ReaderConfig } from "../../services/src/api/readerPresets";
import type { ReviewedRoute } from "./stableExit";

import { COPY } from "./copy/text";
import deployment from "./deployment.json";
import mainnet from "./mainnet.json";
import mainnetBase from "./mainnet.base.json";

export interface Vault { address: Address; name: string; asset: string }

/** One network the app can use. With no contracts set, a network can't run auto-exit. */
export interface Chain {
  key: string;
  chainId: number;
  chainHex: string;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  apiUrl: string;
  router: Address | null;
  adapter: Address | null;
  alarmBook: Address | null;
  /** The block the contracts were deployed in. The limits page reads admin events from here. Null until deployed. */
  deployBlock: number | null;
  planPayTo: Address | null;
  /** Plan prices assume a 6-decimal stablecoin. */
  planToken: Address;
  planTokenSymbol: string;
  // Reown project ID. It is public by design; with none set, the app offers browser wallets only.
  walletConnectProjectId: string | null;
  vaults: Vault[];
  /** Disabled until repository-reviewed feed/path presets are provided. */
  stableRoutes?: ReviewedRoute[];
  /** LP scanning works with the manager alone; arming also needs a deployed, enabled adapter. */
  lp?: { positionManager: Address; adapter: Address | null; alarms?: ReaderConfig[] };
}

/** Robinhood Chain defaults. mainnet.json holds its launch addresses. */
const ROBINHOOD_DEFAULTS: Chain = {
  key: "robinhood",
  chainId: 4663,
  lp: { positionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3", adapter: null },
  stableRoutes: [],
  chainHex: "0x1237",
  chainName: "Robinhood Chain",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  apiUrl: "",
  router: null,
  adapter: null,
  alarmBook: null,
  deployBlock: null,
  planPayTo: null,
  planToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // USDG
  planTokenSymbol: "USDG",
  walletConnectProjectId: null,
  // USDG vaults whose curators gave up every share gate, with none set. Checked on-chain 2026-11-03.
  vaults: [
    { address: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd", name: "Steakhouse USDG", asset: "USDG" },
    { address: "0xBEEff039907422219Fb367e525954DDC092854d9", name: "Grove x Steakhouse USDG", asset: "USDG" },
    { address: "0xd0dACE70434fF7567b108B5a8c2a36C150C830FE", name: "Galaxy USDG RH Stock Tokens", asset: "USDG" },
    { address: "0x8c258F25fc6fBe3f01ccC828E2C3840A46a4a9A2", name: "Yearn Stonk USDG", asset: "USDG" },
    { address: "0x37788ff0c1d4e45A7FE06BC7e71e0cc00121d0A8", name: "Purinta USDG", asset: "USDG" },
  ],
};

/** Base defaults. mainnet.base.json holds its addresses, which stay null until the Base deploy. */
const BASE_DEFAULTS: Chain = {
  key: "base",
  chainId: 8453,
  lp: { positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", adapter: null },
  stableRoutes: [],
  chainHex: "0x2105",
  chainName: "Base",
  rpcUrl: "https://mainnet.base.org",
  explorer: "https://basescan.org",
  apiUrl: "",
  router: null,
  adapter: null,
  alarmBook: null,
  deployBlock: null,
  planPayTo: null,
  planToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  planTokenSymbol: "USDC",
  walletConnectProjectId: null,
  // The launch vaults in deploy/settings.base.example.json. Preflight re-checks their share gates at deploy time.
  vaults: [
    { address: "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A", name: "Spark USDC Vault", asset: "USDC" },
    { address: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61", name: "Gauntlet USDC Prime", asset: "USDC" },
    { address: "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2", name: "Steakhouse Prime USDC", asset: "USDC" },
    { address: "0x1401d1271C47648AC70cBcdfA3776D4A87CE006B", name: "Pangolins USDC", asset: "USDC" },
    { address: "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9", name: "Steakhouse Prime USDC V2", asset: "USDC" },
    { address: "0x050cE30b927Da55177A4914EC73480238BAD56f0", name: "Gauntlet USDC Prime V2", asset: "USDC" },
    { address: "0xbeeff7aE5E00Aae3Db302e4B0d8C883810a58100", name: "Steakhouse High Yield USDC", asset: "USDC" },
    { address: "0xbeef0786756810478b88982DE00F3CD7fdB8e7c7", name: "Grove x Steakhouse USDC", asset: "USDC" },
    { address: "0xbeeff2490FEffa212faC2f6553682C219E6a8845", name: "Steakhouse High Yield USDC Edition", asset: "USDC" },
    { address: "0xBeEfF0be997Cca5B1c13A7433c2004637975739e", name: "Ethena x Steakhouse USDC", asset: "USDC" },
    { address: "0x91C056B6d4311a743614FBc03ac32d4E6A2d3a3c", name: "Clearstar cbAssets Vault", asset: "USDC" },
  ],
};

const robinhood: Chain = { ...ROBINHOOD_DEFAULTS, ...(mainnet as Partial<Chain>) };
const base: Chain = { ...BASE_DEFAULTS, ...(mainnetBase as Partial<Chain>) };
// One Reown project serves the whole app, so Base uses the same one unless it sets its own.
base.walletConnectProjectId ??= robinhood.walletConnectProjectId;

const test = deployment as Partial<Chain>;

/** Every network, Robinhood Chain first. deployment.json is a test deployment, and the app then uses only that. */
export const CHAINS: Chain[] = Object.keys(test).length ? [{ ...robinhood, ...test, key: "test" }] : [robinhood, base];

/** The first network. The services rehearsals compare against it. */
export const CONFIG: Chain = CHAINS[0]!;

/** Auto-exit needs all three contracts. */
export const autoExit = (c: Chain) => Boolean(c.router && c.adapter && c.alarmBook);

/**
 * The networks the app offers. One with no contracts is left out, so it never looks like auto-exit runs there.
 * With none live, the first stays, as check-only.
 */
export function offered(list: Chain[]): Chain[] {
  const on = list.filter(autoExit);
  return on.length ? on : list.slice(0, 1);
}

/** The saved choice if it is still offered, or the first network. */
export function pick(list: Chain[], saved: string | null): Chain {
  return list.find((c) => c.key === saved) ?? list[0]!;
}

const SAVED = "canopy.chain";

/** Storage can be missing or blocked, and then the choice just isn't remembered. */
export function savedChain(store?: Pick<Storage, "getItem">): string | null {
  try {
    return (store ?? localStorage).getItem(SAVED);
  } catch {
    return null;
  }
}

export function saveChain(key: string, store?: Pick<Storage, "setItem">) {
  try {
    (store ?? localStorage).setItem(SAVED, key);
  } catch {
    // Not remembered. The app still works.
  }
}

/** Says that a plan applies to one network. Null when the app offers only one. */
export function planScope(c: Chain, list: Chain[]): string | null {
  const others = list.filter((o) => o.key !== c.key).map((o) => o.chainName);
  if (!others.length) return null;
  return COPY.planPerChain.replaceAll("{chain}", c.chainName).replace("{token}", c.planTokenSymbol).replace("{other}", others.join(" or "));
}
