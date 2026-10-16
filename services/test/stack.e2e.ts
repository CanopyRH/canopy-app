/**
 * The whole stack as real OS processes on real Postgres and a local fork of Robinhood Chain or Base.
 * Two independent operators, each with its own database and API. Telegram, Claude and the feed are local
 * stand-ins, because no live credentials are used. Start: bun test/stack.e2e.ts <rpc url>
 */
import { spawn } from "bun";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, robinhood } from "viem/chains";
import { alarmBookAbi, erc20Abi, routerAbi } from "../src/chain/abi";
import { BASE, ROBINHOOD } from "../src/chain/addresses";
import { postgres } from "../src/store/db";
import { approveTx, armTx, planTx, PLAN_AMOUNTS } from "../../web/src/tx";
import { presetsFor } from "../src/api/presets";

const FORK = process.argv[2]!;
// STACK_SPLIT=1 runs operator A the way production does: one process per role, keys only where needed, and a dead primary RPC.
const SPLIT = process.env.STACK_SPLIT === "1";
const ROOT = join(import.meta.dir, "../..");
const BUN = join(ROOT, ".tools/bun/v1.4.4/bun");
const RPC_PORT = 18546, API_A = 18443, API_B = 18444, MOCK = 18600;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const PG = "postgres://canopy@127.0.0.1:15432";
// Real vaults and real holders. Morpho Blue holds the stablecoin on both chains, so it funds the plan payments.
interface Profile { chain: Chain; stable: Address; weth: Address; swapRouter: Address; feed: Address; morpho: Address; symbol: string; explorer: string; vault: Address; hard: Address; quorum: Address }
const PROFILES: Record<string, Profile> = {
  robinhood: {
    chain: robinhood, stable: ROBINHOOD.usdg, weth: ROBINHOOD.weth, swapRouter: ROBINHOOD.swapRouter, feed: ROBINHOOD.usdgFeed, morpho: ROBINHOOD.morpho,
    symbol: "USDG", explorer: "robinhoodchain.blockscout.com/tx/", vault: ROBINHOOD.steakhouseVault as Address,
    hard: "0x32Ba0BD09218b1b93681ecF83304A1E5566421f1", quorum: "0xf705f15F34be971Abc30e2a4c7C9EB18793bb10e",
  },
  base: {
    chain: base, stable: BASE.usdc, weth: BASE.weth, swapRouter: BASE.swapRouter, feed: BASE.usdcFeed, morpho: BASE.morpho,
    symbol: "USDC", explorer: "basescan.org/tx/", vault: "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2",
    hard: "0x9b3d66c4ac6e282e45b51a07efea05eb90cf85b8", quorum: "0x3663774ab162264a7b3fdd1d3b977786cdab5dba",
  },
};
const P = PROFILES[(await createPublicClient({ transport: http(FORK) }).getChainId()) === ROBINHOOD.chainId ? "robinhood" : "base"]!;
const VAULT = P.vault, HOLDER_HARD = P.hard, HOLDER_QUORUM = P.quorum;
const PAY_TO = "0x00000000000000000000000000000000000caf0e" as Address;
const SECRET = "local-webhook-secret";
const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const keeperKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const wA = `0x${"a1".padStart(64, "0")}` as Hex;
const wB = `0x${"b2".padStart(64, "0")}` as Hex;

const results: [string, boolean][] = [];
const check = (n: string, ok: boolean, d = "") => { results.push([n, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const waitFor = async (what: string, fn: () => Promise<boolean>, ms = 45_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* still starting */ }
    await Bun.sleep(250);
  }
  console.log(`  timed out waiting for ${what}`);
  return false;
};
