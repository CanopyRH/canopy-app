import { encodeFunctionData, getAddress, keccak256, maxUint256, stringToHex, type Address, type Hex } from "viem";
import { erc20Abi, routerAbi } from "../chain/abi";
import { TERMS } from "./terms";

/**
 * Calldata for the things an agent may need to hand to a wallet. Nothing here signs, holds a key or takes a recipient:
 * the router has no recipient field, so every exit pays the position owner. These are pure functions of their inputs.
 */

export interface Call {
  step: "approve" | "arm" | "exit" | "disarmAll";
  to: Address;
  data: Hex;
  /** Always "0": none of these calls carries ETH. */
  value: "0";
  note: string;
}

/** The most keys one position can arm. Mirrors ExitRouter.MAX_KEYS. */
export const MAX_KEYS = 8;
const ZERO_KEY = `0x${"00".repeat(32)}` as Hex;

export const termsHash = () => keccak256(stringToHex(TERMS));

export function approveCall(vault: Address, router: Address): Call {
  return {
    step: "approve",
    to: getAddress(vault),
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, maxUint256] }),
    value: "0",
    note: "Lets the router withdraw the owner's vault shares when an exit runs. Skip it if the allowance to the router is already large.",
  };
}

/** The raw harbour: the vault's own payout, no slippage setting and no swap legs, exactly as the app arms. */
export function armCall(router: Address, adapter: Address, vault: Address, keys: Hex[]): Call {
  return {
    step: "arm",
    to: getAddress(router),
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: "arm",
      args: [{ adapter, target: vault, tokenId: 0n, harbour: 0, maxSlipBps: 0, termsHash: termsHash(), keys, swaps: [] }],
    }),
    value: "0",
    note: "Arms the sender's own position. Arming again replaces the list of keys, so send every key the position should keep.",
  };
}

export function exitCall(router: Address, posId: Hex): Call {
  return {
    step: "exit",
    to: getAddress(router),
    data: encodeFunctionData({ abi: routerAbi, functionName: "exit", args: [posId, ZERO_KEY, 0n] }),
    value: "0",
    note: "Exit Now. Only the owner can send it without an alarm, and the funds go to the owner. Free.",
  };
}

export function disarmAllCall(router: Address): Call {
  return {
    step: "disarmAll",
    to: getAddress(router),
    data: encodeFunctionData({ abi: routerAbi, functionName: "disarmAll" }),
    value: "0",
    note: "Disarms every position of the sender in one transaction. Only the owner should ever send it. Free.",
  };
}

/** What the API reads from the chain to answer a calldata request. Read-only. */
export interface ChainReads {
  /** AlarmBook: whether the key was ever registered, and whether the router could arm it right now. */
  keyState(key: Hex): Promise<{ known: boolean; armable: boolean; coverage?: string }>;
  /** ExitRouter.positionId for an ERC-20 vault position (token id 0). */
  positionId(owner: Address, vault: Address): Promise<Hex>;
  isArmed(posId: Hex): Promise<boolean>;
}

export interface CalldataChain {
  chainId: number;
  router: Address;
  adapter: Address;
  alarmBook: Address;
  reads: ChainReads;
}

export type KeyRefusal = { key: Hex; reason: "not_registered" | "not_armable" | "unreadable" | "warming-up" | "stale" };

/** Every key the router would turn away now, with the reason. An empty list means each one is registered and armable. */
export async function refusedKeys(reads: ChainReads, keys: Hex[]): Promise<KeyRefusal[]> {
  const out = await Promise.all(
    keys.map(async (key): Promise<KeyRefusal | null> => {
      try {
        const s = await reads.keyState(key);
        if (!s.known) return { key, reason: "not_registered" };
        if(s.coverage === "warming-up" || s.coverage === "stale")return {key,reason:s.coverage};
        return s.armable ? null : { key, reason: "not_armable" };
      } catch {
        return { key, reason: "unreadable" };
      }
    }),
  );
  return out.filter((x): x is KeyRefusal => x !== null);
}
