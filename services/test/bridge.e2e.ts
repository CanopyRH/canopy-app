/**
 * Runs the bridge command against a local fork of Ethereum Sepolia and the real bridge contract.
 * Usage: bun test/bridge.e2e.ts <ethereum sepolia rpc url>
 */
import { spawn, spawnSync } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, parseAbiItem, parseEther, type Address } from "viem";
import { sepolia } from "viem/chains";

const FORK = process.argv[2]!;
const ROOT = join(import.meta.dir, "../..");
const BUN = join(ROOT, ".tools/bun/v1.4.4/bun");
const PORT = 18560;
const RPC = `http://127.0.0.1:${PORT}`;
const BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";
const work = mkdtempSync(join(tmpdir(), "canopy-bridge-"));

const results: boolean[] = [];
const check = (n: string, ok: boolean, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const cli = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync([BUN, "deploy/testnet.ts", ...args], {
    cwd: join(ROOT, "services"),
    env: { ...(process.env as Record<string, string>), L1_RPC_URL: RPC, TESTNET_DIR: join(work, "testnet"), ...env },
  });
  return { ok: r.exitCode === 0, text: r.stdout.toString() + r.stderr.toString() };
};
const anvil = spawn([join(ROOT, ".tools/foundry/v1.8.6/anvil"), "--fork-url", FORK, "--port", String(PORT), "--silent", "--no-rate-limit"], { stdout: "ignore", stderr: "ignore" });

try {
  const client = createPublicClient({ chain: sepolia, transport: http(RPC), cacheTime: 0 });
  for (let i = 0; ; i++) {
    try { await client.getBlockNumber(); break; } catch { if (i > 120) throw new Error("anvil did not start"); await Bun.sleep(500); }
  }
  const deployer = cli(["keys"]).text.match(/address: (0x[0-9a-fA-F]{40})/)?.[1] as Address;

  check("bridge refuses an unfunded wallet", !cli(["bridge"]).ok);
  check("bridge refuses the wrong chain", cli(["bridge"], { L1_RPC_URL: "https://sepolia.base.org" }).text.includes("not Ethereum Sepolia"));

  const claim = parseEther("0.05"); // The mining faucet's smallest payout
  await client.request({ method: "anvil_setBalance", params: [deployer, `0x${claim.toString(16)}`] } as never);
  const from = await client.getBlockNumber();
  const bridged = cli(["bridge"]);
  check("bridge sent the deposit", bridged.ok, bridged.ok ? "" : bridged.text.slice(-400));

  const logs = await client.getLogs({
    address: BRIDGE, fromBlock: from + 1n,
    event: parseAbiItem("event ETHDepositInitiated(address indexed from, address indexed to, uint256 amount, bytes extraData)"),
  });
  const log = logs[0]?.args;
  check("the real bridge recorded one deposit", logs.length === 1);
  check("the deposit goes to the same address", log?.from === deployer && log?.to === deployer);
  check("the deposit is the claim less the gas reserve", log?.amount === claim - parseEther("0.01"), `${log?.amount}`);
} catch (e) {
  check("run finished", false, (e as Error).message.slice(0, 300));
} finally {
  anvil.kill();
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
