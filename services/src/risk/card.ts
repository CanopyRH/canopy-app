import { toFunctionSelector, type Address, type PublicClient } from "viem";
import { erc20Abi, vaultAbi, vaultV2Abi } from "../chain/abi";

export interface CardNumbers {
  vault: Address;
  name: string;
  assetSymbol: string;
  assetDecimals: number;
  totalAssets: string | null;
  version: "v1" | "v2" | "other";
  owner: Address | null;
  curator: Address | null;
  idleAssets: string;
  gates: { name: string; address: Address | null; abdicated: boolean | null }[];
  forceDeallocatePenaltyZero: boolean | null;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const GATES = [
  ["sendSharesGate", "setSendSharesGate(address)"],
  ["receiveSharesGate", "setReceiveSharesGate(address)"],
  ["receiveAssetsGate", "setReceiveAssetsGate(address)"],
] as const;

const attempt = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};
