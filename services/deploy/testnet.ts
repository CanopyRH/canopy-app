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
