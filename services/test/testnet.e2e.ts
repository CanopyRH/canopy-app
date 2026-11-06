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
const cliAsync = async (args: string[], env: Record<string, string> = {}) => {
  const r = spawn([BUN, "deploy/testnet.ts", ...args], {
    cwd: join(ROOT, "services"), stdout: "pipe", stderr: "pipe",
    env: { ...(process.env as Record<string, string>), RPC_URL: RPC, TESTNET_DIR: dir, WEB_DEPLOYMENT_FILE: webFile, ...env },
  });
  const [out, err] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text()]);
  return { ok: (await r.exited) === 0, text: out + err };
};
const anvil = spawn([join(ROOT, ".tools/foundry/v1.8.6/anvil"), "--fork-url", FORK, "--port", String(PORT + 1), "--block-time", "2", "--silent", "--no-rate-limit", "--no-priority-fee"], { stdout: "ignore", stderr: "ignore" });

// Anvil quotes a 1 gwei tip, about 150 times the live chain's. The proxy passes on the live tip, in its own process because cli() blocks this one.
const liveTip = await createPublicClient({ chain: baseSepolia, transport: http(FORK) }).request({ method: "eth_maxPriorityFeePerGas" });
const proxy = spawn([BUN, join(import.meta.dir, "tip-proxy.ts"), String(PORT), String(PORT + 1), liveTip], { stdout: "ignore", stderr: "ignore" });

try {
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC), cacheTime: 0 });
  for (let i = 0; ; i++) {
    try { await client.getBlockNumber(); break; } catch { if (i > 120) throw new Error("anvil did not start"); await Bun.sleep(500); }
  }
  const rpc = (method: string, params: unknown[]) => client.request({ method, params } as never);

  const early = cli(["deploy"]);
  check("deploy refuses to run before keys exist", !early.ok && early.text.includes("no keys yet"));

  const keys = cli(["keys"]);
  const deployer = keys.text.match(/address: (0x[0-9a-fA-F]{40})/)?.[1] as Address;
  const before = readFileSync(join(dir, "keys.json"), "utf8");
  check("keys were generated", keys.ok && Boolean(deployer));
  check("the key file is private to this user", (statSync(join(dir, "keys.json")).mode & 0o777) === 0o600);
  check("no private key was printed", !Object.values(JSON.parse(before) as Record<string, string>).some((k) => keys.text.includes(k.slice(2))));
  cli(["keys"]);
  check("running keys again keeps the same keys", readFileSync(join(dir, "keys.json"), "utf8") === before);

  const unfunded = cli(["deploy"]);
  check("deploy refuses an unfunded wallet", !unfunded.ok && unfunded.text.includes("needs"));
  const wrongChain = cli(["deploy"], { RPC_URL: "https://mainnet.base.org" });
  check("deploy refuses mainnet", !wrongChain.ok && wrongChain.text.includes("not Base Sepolia"));

  // Exactly the minimum, so the rehearsal proves that minimum is enough.
  const needed = parseEther(cli(["status"]).text.match(/needs ([0-9.]+)/)![1]!);
  await rpc("anvil_setBalance", [deployer, `0x${needed.toString(16)}`]);
  const startBlock = await client.getBlockNumber();
  const deployed = cli(["deploy"]);
  check("deploy ran end to end", deployed.ok, deployed.ok ? "" : deployed.text.slice(-500));
  if (!deployed.ok) throw new Error("stopping");
  check("the verifier passed during deploy, with no setup left", /all \d+ checks passed/.test(deployed.text));
  check("deploy cannot run twice", !cli(["deploy"]).ok);
  check("status says to finish", cli(["status"]).text.includes("Run: testnet.ts finish"));

  const finished = cli(["finish"]);
  check("finish ran", finished.ok, finished.ok ? "" : finished.text.slice(-500));
  check("the verifier passed again at go-live", /all \d+ checks passed/.test(finished.text));
  const { settings, ...d } = JSON.parse(readFileSync(join(dir, "plan/deployment.json"), "utf8")) as Deployment & { settings: Settings };
  const onMainnet = await verifyDeployment(client as never, d, { ...settings, chainId: 8453 });
  check("the verifier refuses the test Timelock on mainnet", onMainnet.some((c) => c.name === "The test Timelock is refused on mainnet" && !c.ok));
  const web = JSON.parse(readFileSync(webFile, "utf8")) as { chainId: number; router: string; alarmBook: string; vaults: { address: Address }[] };
  check("the web app config points at this deployment", web.chainId === 84532 && Boolean(web.router) && Boolean(web.alarmBook) && web.vaults.length === 1);
  check("status reports live", cli(["status"]).text.includes("deployment: live"));

  const tester = "0x000000000000000000000000000000000000bEEF" as Address;
  check("give funded a test wallet", cli(["give", tester]).ok);
  const shares = await client.readContract({ address: web.vaults[0]!.address, abi: erc20Abi, functionName: "balanceOf", args: [tester] });
  check("the test wallet holds vault shares", shares === 1_000_000_000n);

  const smoke = cli(["smoke"]);
  const time = smoke.text.match(/Exit time: ([0-9.]+)s/)?.[1];
  check("the real services exited a position on 2-second blocks", smoke.ok, smoke.ok ? `${time}s after the pause was mined` : smoke.text.slice(-600));
  check("a second smoke test also passes", cli(["smoke"]).ok);
  // The drain reference needs 10 minutes of chain time, and a confirmation a minute after the first poke. Move the clock on a timer.
  const clock = setInterval(() => void rpc("evm_increaseTime", [120]).then(() => rpc("evm_mine", [])).catch(() => {}), 20_000);
  const hack = await cliAsync(["hack"]);
  clearInterval(clock);
  const hackTime = hack.text.match(/Exit time: ([0-9.]+)s/)?.[1];
  check("a real drain and a report fired the combined alarm", hack.ok, hack.ok ? `${hackTime}s after the drain was mined` : hack.text.slice(-600));
  const latest = await client.getBlockNumber();
  let gas = 0n;
  for (let b = startBlock + 1n; b <= latest; b++) gas += (await client.getBlock({ blockNumber: b })).gasUsed;
  const cost = gas * (await createPublicClient({ chain: baseSepolia, transport: http(FORK) }).getGasPrice());
  check("the full run costs under a third of the minimum at today's gas price", cost * 3n < needed, `${gas} gas, ${formatEther(cost)} of ${formatEther(needed)} ETH`);
} catch (e) {
  check("rehearsal finished", false, (e as Error).message.slice(0, 300));
} finally {
  proxy.kill();
  anvil.kill();
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
