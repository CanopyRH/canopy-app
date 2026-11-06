import type { CardNumbers } from "../src/risk/card";

const ZERO = "0x0000000000000000000000000000000000000000";

/** A launch vault's saved card with made-up amounts: every gate off and given up, a curator set, most funds lent out. */
export const LAUNCH_VAULT = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
export const LAUNCH_CARD: CardNumbers = {
  vault: LAUNCH_VAULT as CardNumbers["vault"],
  name: "Steakhouse USDG",
  assetSymbol: "USDG",
  assetDecimals: 6,
  totalAssets: "4210377000000",
  version: "v2",
  owner: "0x00000000000000000000000000000000000000a1",
  curator: "0x00000000000000000000000000000000000000c1",
  idleAssets: "1052594000000",
  gates: [
    { name: "sendSharesGate", address: ZERO, abdicated: true },
    { name: "receiveSharesGate", address: ZERO, abdicated: true },
    { name: "receiveAssetsGate", address: ZERO, abdicated: true },
  ] as CardNumbers["gates"],
  forceDeallocatePenaltyZero: true,
};

/** A harsher card: one gate on, one still open, one given up, a long name, little idle. */
export const GATED_CARD: CardNumbers = {
  ...LAUNCH_CARD,
  vault: "0x00000000000000000000000000000000000000d2",
  name: "Example <b>Strategy</b> & Vault, A Long Name",
  idleAssets: "1250000",
  totalAssets: "98000000000",
  gates: [
    { name: "sendSharesGate", address: "0x00000000000000000000000000000000000000e5", abdicated: false },
    { name: "receiveSharesGate", address: ZERO, abdicated: false },
    { name: "receiveAssetsGate", address: ZERO, abdicated: true },
  ] as CardNumbers["gates"],
  forceDeallocatePenaltyZero: false,
};
