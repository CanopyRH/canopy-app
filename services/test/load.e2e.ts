/**
 * How long one alarm takes to clear when many positions share it. Real keeper and indexer processes at production loop
 * speed, on a local fork of Robinhood Chain (a block a second, slower than the real ~0.1s) or Base (every 2 seconds).
 * Start: bun test/load.e2e.ts <rpc url> [positions]
 */
import { spawn } from "bun";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseEventLogs, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, robinhood } from "viem/chains";
import { alarmBookAbi, erc20Abi, routerAbi } from "../src/chain/abi";
import { BASE, ROBINHOOD } from "../src/chain/addresses";
import { postgres } from "../src/store/db";
import { approveTx, armTx } from "../../web/src/tx";

const FORK = process.argv[2]!;
const COUNT = Number(process.argv[3] ?? 100);
const TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_MS ?? 900_000);
const ROOT = join(import.meta.dir, "../..");
const BUN = join(ROOT, ".tools/bun/v1.4.4/bun");
const RPC_PORT = 18556;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const PG = "postgres://canopy@127.0.0.1:15432";
const ON_RH = (await createPublicClient({ transport: http(FORK) }).getChainId()) === ROBINHOOD.chainId;
const P = ON_RH
  ? { chain: robinhood, stable: ROBINHOOD.usdg, weth: ROBINHOOD.weth, swapRouter: ROBINHOOD.swapRouter, feed: ROBINHOOD.usdgFeed, blockSec: 1,
      vault: ROBINHOOD.steakhouseVault as Address, whale: "0xfFdA3d52e9FCAF40E610B59ddc7bAf2c1594Bd21" as Address }
  : { chain: base, stable: BASE.usdc as Address, weth: BASE.weth as Address, swapRouter: BASE.swapRouter as Address, feed: BASE.usdcFeed as Address, blockSec: 2,
      vault: "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2" as Address, whale: "0x9b3d66c4ac6e282e45b51a07efea05eb90cf85b8" as Address };
const VAULT = (process.env.LOAD_VAULT ?? P.vault) as Address;
const WHALE = (process.env.LOAD_WHALE ?? P.whale) as Address;
const PAY_TO = "0x00000000000000000000000000000000000caf0e" as Address;
const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const keeperKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const keeper = privateKeyToAccount(keeperKey).address;
const ETH = "0x56BC75E2D63100000";

const results: [string, boolean][] = [];
const check = (n: string, ok: boolean, d = "") => { results.push([n, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const waitFor = async (what: string, fn: () => Promise<boolean>, ms = 120_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* still starting */ }
    await Bun.sleep(250);
  }
  console.log(`  timed out waiting for ${what}`);
  return false;
};
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
