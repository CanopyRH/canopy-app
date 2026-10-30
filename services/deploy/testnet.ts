/**
 * Base Sepolia deployment, one step at a time. Uses throwaway test keys and a test stablecoin.
 * Commands: keys | status | bridge | deploy | finish | give <address> | smoke | hack
 * Settings: RPC_URL (default https://sepolia.base.org), L1_RPC_URL (Ethereum Sepolia, for bridge), TESTNET_DIR (default deploy/testnet).
 */
import { spawn } from "bun";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, type Address, type Hex, type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";
import { alarmBookAbi, erc20Abi } from "../src/chain/abi";
import { keyOf, Kind, presetsFor, type Detector } from "../src/api/presets";
import { migrate, postgres, type Db } from "../src/store/db";
import { approveTx, armTx, planTx, PLAN_AMOUNTS, registerTx } from "../../web/src/tx";
import { writePlan, type Call, type Deployment, type Settings } from "./plan";
import { verifyDeployment } from "./verify";

export const SEPOLIA = {
  chainId: 84532,
  weth: "0x4200000000000000000000000000000000000006",
  swapRouter: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
  usdcFeed: "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
} as const;

const ROOT = join(import.meta.dir, "../..");
const BUN = join(ROOT, ".tools/bun/v1.4.4/bun");
const RPC = process.env.RPC_URL ?? "https://sepolia.base.org";
const DIR = process.env.TESTNET_DIR ?? join(ROOT, "deploy/testnet");
const PG = process.env.PG_URL ?? "postgres://canopy@127.0.0.1:15432";
const TIMELOCK_SECONDS = 60; // A delay on the test run, so the schedule-then-execute path stays tested.
const RUN_GAS = parseEther("0.0002");
const ROLE_FLOOR = parseEther("0.00005");
const ROLE_TOPUP = parseEther("0.00015");
const L1_RPC = process.env.L1_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const L1_BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120"; // Base's L1StandardBridge on Ethereum Sepolia
const L1_GAS = parseEther("0.01"); // Left behind on Ethereum Sepolia to pay for the bridge transaction
const FUNDED_ROLES = ["proposer", "guardian", "keeper", "user"] as const;
const ROLES = ["deployer", "proposer", "guardian", "keeper", "user", "payTo", "watcher1", "watcher2", "watcher3"] as const;
type Role = (typeof ROLES)[number];
type Keys = Record<Role, Hex>;
interface State { usd?: Address; vault?: Address; plan?: boolean; scheduledAt?: number; finished?: boolean }

const keysFile = join(DIR, "keys.json");
const stateFile = join(DIR, "state.json");
const planDir = join(DIR, "plan");
const zero32 = `0x${"00".repeat(32)}` as Hex;

const readState = (): State => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {});
const saveState = (s: State) => writeFileSync(stateFile, `${JSON.stringify(s, null, 2)}\n`);
const addr = (k: Hex) => privateKeyToAccount(k).address;
const fail = (m: string): never => {
  console.error(`STOP: ${m}`);
  process.exit(1);
};

function loadKeys(): Keys {
  if (!existsSync(keysFile)) fail("no keys yet. Run: testnet.ts keys");
  return JSON.parse(readFileSync(keysFile, "utf8"));
}

const client = createPublicClient({ chain: baseSepolia, transport: http(RPC), pollingInterval: 500, cacheTime: 0 }) as PublicClient;
const wallet = (k: Hex) => createWalletClient({ chain: baseSepolia, transport: http(RPC), account: privateKeyToAccount(k), pollingInterval: 500 });

async function send(k: Hex, tx: { to: Address; data?: Hex; value?: bigint | string }) {
  const hash = await wallet(k).sendTransaction({ ...tx, value: tx.value === undefined ? undefined : BigInt(tx.value) } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") fail(`transaction reverted: ${hash}`);
  return hash;
}

async function deployArtifact(k: Hex, file: string, args: unknown[] = []) {
  const a = JSON.parse(readFileSync(join(ROOT, "contracts/out", file), "utf8"));
  const hash = await wallet(k).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: args as never });
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) fail(`deploy failed: ${file}`);
  return r.contractAddress as Address;
}
