import { encodeFunctionData, getAddress, isAddress, keccak256, maxUint256, parseAbi, stringToHex, type Address, type Hex } from "viem";
import { Kind, type Detector } from "../../services/src/api/presets";
import { TERMS } from "./copy/text";
import sanctioned from "./sanctioned.json";

/** Every transaction is built here, in the browser. The server never sees or supplies calldata. */

export const routerAbi = parseAbi([
  "struct SwapLeg { address token; address feed; uint32 heartbeat; uint8 tokenDecimals; bytes path; }",
  "struct ArmParams { address adapter; address target; uint256 tokenId; uint8 harbour; uint16 maxSlipBps; bytes32 termsHash; bytes32[] keys; SwapLeg[] swaps; }",
  "function arm(ArmParams a) returns (bytes32)",
  "function exit(bytes32 posId, bytes32 alarmKey, uint256 amount) returns (uint256)",
  "function disarmAll()",
  "function positionId(address owner, address adapter, address target, uint256 tokenId) pure returns (bytes32)",
  "function isArmed(bytes32 posId) view returns (bool)",
]);
export const alarmBookAbi = parseAbi([
  "struct Detector { uint8 kind; address target; uint256 threshold; uint32 window; bytes32 a; bytes32 b; }",
  "function register(Detector d) returns (bytes32)",
  "function state(bytes32) view returns (bool exists, uint64 firedAt, uint64 snapAt, uint256 baseline, uint256 snap, uint64 episodeAt, uint64 pendingAt)",
  "function check(bytes32) view returns (bool)",
  "function armable(bytes32) view returns (bool)",
  "function isLive(bytes32, uint256) view returns (bool)",
]);
const erc20Abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);

export interface Tx { to: Address; data: Hex }

export const ZERO_KEY = `0x${"00".repeat(32)}` as Hex;
export const PLAN_AMOUNTS = { months3: 15_000_000n, year: 60_000_000n } as const;

const blocked = new Set(sanctioned.addresses);

export const termsHash = () => keccak256(stringToHex(TERMS));
export const isBlocked = (a: string) => blocked.has(a.toLowerCase());
export const parseWallet = (s: string): Address | null => (isAddress(s.trim(), { strict: false }) ? getAddress(s.trim().toLowerCase()) : null);

/** A DRAIN window under 20 minutes rolls its reference every few seconds, so one flash deposit can move it. The app refuses those. */
export const MIN_DRAIN_WINDOW = 1_200;

/** Registration is open to anyone. A key that was never registered can never fire. */
export function registerTx(book: Address, d: Detector): Tx {
  if (d.kind === Kind.DRAIN && d.window < MIN_DRAIN_WINDOW) throw new Error(`A drain alarm needs a window of at least ${MIN_DRAIN_WINDOW} seconds.`);
  return { to: book, data: encodeFunctionData({ abi: alarmBookAbi, functionName: "register", args: [d] }) };
}

export function approveTx(vault: Address, router: Address): Tx {
  return { to: vault, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, maxUint256] }) };
}

/**
 * Vault positions are paid out as the vault pays them: the raw harbour, no slippage setting and no swap legs. The router
 * refuses legs on the raw harbour, so the list is always empty. The app does not offer the stablecoin harbour.
 */
export function armTx(router: Address, adapter: Address, vault: Address, keys: Hex[]): Tx {
  return {
    to: router,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: "arm",
      args: [{ adapter, target: vault, tokenId: 0n, harbour: 0, maxSlipBps: 0, termsHash: termsHash(), keys, swaps: [] }],
    }),
  };
}

export function exitTx(router: Address, posId: Hex): Tx {
  return { to: router, data: encodeFunctionData({ abi: routerAbi, functionName: "exit", args: [posId, ZERO_KEY, 0n] }) };
}

export function disarmAllTx(router: Address): Tx {
  return { to: router, data: encodeFunctionData({ abi: routerAbi, functionName: "disarmAll" }) };
}

export function planTx(token: Address, payTo: Address, amount: bigint): Tx {
  return { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [payTo, amount] }) };
}
