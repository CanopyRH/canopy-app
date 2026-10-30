/**
 * Rehearses every Base Sepolia command on a local fork with 2-second blocks, like the real chain.
 * Start Postgres first, then: bun test/testnet.e2e.ts <base sepolia rpc url>
 */
import { spawn, spawnSync } from "bun";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, formatEther, http, parseEther, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { erc20Abi } from "../src/chain/abi";
import type { Deployment, Settings } from "../deploy/plan";
import { verifyDeployment } from "../deploy/verify";

const FORK = process.argv[2]!;
const ROOT = join(import.meta.dir, "../..");
const BUN = join(ROOT, ".tools/bun/v1.4.4/bun");
const PORT = 18548;
const RPC = `http://127.0.0.1:${PORT}`;
const work = mkdtempSync(join(tmpdir(), "canopy-testnet-"));
const dir = join(work, "testnet");
const webFile = join(work, "deployment.json");

const results: boolean[] = [];
const check = (n: string, ok: boolean, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const cli = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync([BUN, "deploy/testnet.ts", ...args], {
    cwd: join(ROOT, "services"),
    env: { ...(process.env as Record<string, string>), RPC_URL: RPC, TESTNET_DIR: dir, WEB_DEPLOYMENT_FILE: webFile, ...env },
  });
  return { ok: r.exitCode === 0, text: r.stdout.toString() + r.stderr.toString() };
};
const anvil = spawn([join(ROOT, ".tools/foundry/v1.8.6/anvil"), "--fork-url", FORK, "--port", String(PORT + 1), "--block-time", "2", "--silent", "--no-rate-limit", "--no-priority-fee"], { stdout: "ignore", stderr: "ignore" });

// Anvil quotes a 1 gwei tip, about 150 times the live chain's. The proxy passes on the live tip, in its own process because cli() blocks this one.
const liveTip = await createPublicClient({ chain: baseSepolia, transport: http(FORK) }).request({ method: "eth_maxPriorityFeePerGas" });
const proxy = spawn([BUN, join(import.meta.dir, "tip-proxy.ts"), String(PORT), String(PORT + 1), liveTip], { stdout: "ignore", stderr: "ignore" });
