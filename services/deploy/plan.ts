/**
 * Turns a broadcast deployment into files a multisig can review and sign. Holds no keys and sends nothing.
 * Usage: bun deploy/plan.ts <run-latest.json> <settings.json> <out dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex } from "viem";
import { alarmBookAbi, routerAbi } from "../src/chain/abi";
import { registrationOrder } from "../src/api/presets";

export interface Settings {
  chainId: number;
  proposer: Address;
  guardian: Address;
  stable: Address;
  weth: Address;
  swapRouter: Address;
  stableFeed: Address;
  heartbeat: number;
  adminExpiry: number;
  watchers: Address[];
  vaults: Address[];
  /** The app's plan payment Safe and API address, for the web config. */
  planPayTo?: Address;
  apiUrl?: string;
  /** Testnet only: admins may be plain wallets. Refused on mainnet. */
  allowEoaAdmin?: boolean;
  /** Seconds each admin change waits in the Timelock. 0 (the default) applies a change as soon as the multisig signs. */
  timelockDelay?: number;
  /** Testnet only: deploys a TestTimelock with this delay. Refused on mainnet. */
  testTimelockDelay?: number;
}
export interface Deployment { timelock: Address; alarmBook: Address; router: Address; adapter: Address; startBlock: number }
export interface Call { to: Address; value: string; data: Hex }

const timelockAbi = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 salt) returns (bytes32)",
  "function execute(address target, uint256 value, bytes data, bytes32 salt) payable returns (bytes)",
]);
