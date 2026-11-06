import type { Address } from "viem";

export const BASE = {
  chainId: 8453,
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  usdcFeed: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
  weth: "0x4200000000000000000000000000000000000006",
  swapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
} as const satisfies Record<string, Address | number>;

export const ROBINHOOD = {
  chainId: 4663,
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  usdgFeed: "0x8bEeE3503F6860D5dac4cE26b5eEe92982951c2e", // Chainlink USDG/USD, 8 decimals
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2",
  morpho: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
  steakhouseVault: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const satisfies Record<string, Address | number>;

const EXPLORERS: Record<number, string> = {
  8453: "https://basescan.org", 84532: "https://sepolia.basescan.org", 4663: "https://robinhoodchain.blockscout.com",
};

/** How long a plan payment or a new arm should have been in the chain before it is trusted. */
const CONFIRM_MS = 10_000;

/** What the services need per chain. Robinhood Chain makes about 10 blocks a second, Base one every 2 seconds. */
export function chainParts(chainId: number) {
  const onRobinhood = chainId === ROBINHOOD.chainId;
  const blockMs = onRobinhood ? 100 : 2_000;
  return {
    morpho: (onRobinhood ? ROBINHOOD.morpho : BASE.morpho) as Address,
    multicall3: (onRobinhood ? ROBINHOOD.multicall3 : BASE.multicall3) as Address, // same address on Base Sepolia
    // The ops chat hears when the indexer is 40 seconds behind.
    maxLagBlocks: BigInt(40_000 / blockMs),
    // About 10 seconds of blocks: 100 on Robinhood Chain, 5 on Base. See CONFIRMATIONS.
    confirmations: BigInt(Math.ceil(CONFIRM_MS / blockMs)),
  };
}

export const txUrl = (chainId: number, tx: string | null) => (tx && EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/tx/${tx}` : undefined);
