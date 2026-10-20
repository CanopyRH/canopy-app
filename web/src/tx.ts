import { encodeFunctionData, getAddress, isAddress, keccak256, maxUint256, parseAbi, stringToHex, type Address, type Hex } from "viem";
import type { Detector } from "../../services/src/api/presets";
import { TERMS } from "./copy/text";
import sanctioned from "./sanctioned.json";

/** Every transaction is built here, in the browser. The server never sees or supplies calldata. */

export const routerAbi = parseAbi([
  "struct ArmParams { address adapter; address target; uint256 tokenId; uint8 harbour; uint16 maxSlipBps; bytes32 termsHash; bytes32[] keys; }",
  "function arm(ArmParams a) returns (bytes32)",
  "function exit(bytes32 posId, bytes32 alarmKey, uint256 amount) returns (uint256)",
  "function disarmAll()",
  "function positionId(address owner, address adapter, address target, uint256 tokenId) pure returns (bytes32)",
  "function isArmed(bytes32 posId) view returns (bool)",
]);
export const alarmBookAbi = parseAbi([
  "struct Detector { uint8 kind; address target; uint256 threshold; uint32 window; bytes32 a; bytes32 b; }",
  "function register(Detector d) returns (bytes32)",
  "function state(bytes32) view returns (bool exists, uint64 firedAt, uint64 snapAt, uint256 baseline, uint256 snap)",
  "function check(bytes32) view returns (bool)",
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
