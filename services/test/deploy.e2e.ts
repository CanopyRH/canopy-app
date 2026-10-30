/**
 * Rehearses the real launch sequence on a local fork of Robinhood Chain or Base, in strict mainnet mode.
 * Start: bun test/deploy.e2e.ts <rpc url> [timelock delay in seconds, default 0]. Nothing leaves the local fork.
 */
import { spawn, spawnSync } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { base, robinhood } from "viem/chains";
import { erc20Abi, routerAbi } from "../src/chain/abi";
import { BASE, chainParts, ROBINHOOD } from "../src/chain/addresses";
import { presetsFor } from "../src/api/presets";
import { readBroadcast, writePlan, type Call, type Settings } from "../deploy/plan";
import { verifyDeployment } from "../deploy/verify";
import { CONFIG } from "../../web/src/config";
import { approveTx, armTx, exitTx } from "../../web/src/tx";

const FORK = process.argv[2]!;
const DELAY = Number(process.argv[3] ?? 0);
const ROOT = join(import.meta.dir, "../..");
const FORGE = join(ROOT, ".tools/foundry/v1.8.6/forge");
const PORT = 18547;
const RPC = `http://127.0.0.1:${PORT}`;
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// Real holders and real multisig contracts on each chain. The multisigs only stand in for the Safes.
interface Profile { chain: Chain; stable: Address; weth: Address; swapRouter: Address; feed: Address; symbol: string; holder: Address; vault: Address; proposerOf: Address; guardianOf: Address; admin: "owner" | "curator" }
const CHAINS: Record<number, Profile> = {
  [ROBINHOOD.chainId]: {
    chain: robinhood, stable: ROBINHOOD.usdg, weth: ROBINHOOD.weth, swapRouter: ROBINHOOD.swapRouter, feed: ROBINHOOD.usdgFeed, symbol: "USDG",
    holder: "0x60822b4f00b75d47B847c67011fe13b8027624f0" as Address, vault: ROBINHOOD.steakhouseVault as Address,
    proposerOf: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd" as Address, guardianOf: "0xBEEff039907422219Fb367e525954DDC092854d9" as Address, admin: "owner",
  },
  [BASE.chainId]: {
    chain: base, stable: BASE.usdc, weth: BASE.weth, swapRouter: BASE.swapRouter, feed: BASE.usdcFeed, symbol: "USDC",
    holder: "0x9b3d66c4ac6e282e45b51a07efea05eb90cf85b8" as Address, vault: "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2" as Address,
    proposerOf: "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9" as Address, guardianOf: "0x050cE30b927Da55177A4914EC73480238BAD56f0" as Address, admin: "curator",
  },
};
const WATCHERS: Address[] = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000a3"];
