/**
 * The Base launch, rehearsed on a local fork of Base mainnet with the real commands in RUNBOOK.md order: check the vaults,
 * preflight, the real Deploy.s.sol (simulated, then broadcast), plan.ts, verify.ts, register-presets.ts (dry run, run, run
 * again) and web-base-config.ts. Nothing leaves the local fork.
 *
 * What stands in for the real run, and only here:
 *  - The deployer and registrar are anvil's first public test key. The real run uses the deploy/mainnet/ keystore.
 *  - The proposer, guardian and payments Safes are real Safe 1.4.1 proxies, made on the fork from Base's own Safe factory,
 *    each 2 of 3 over anvil's public test accounts. The real run uses the three Safes created on Base.
 *  - Watchers and keeper are test addresses. The services env carries stand-in secrets so preflight can read every line.
 * The command output is saved, with no keys and no local paths, to the out dir (default deploy/out/8453-rehearsal).
 *
 * Start: bun test/base-launch.e2e.ts <base rpc url> [out dir]
 */
import { spawn, spawnSync } from "bun";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, formatEther, http, parseAbi, parseAbiItem, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { BASE } from "../src/chain/addresses";
import { CHAINS } from "../../web/src/config";

const FORK = process.argv[2]!;
const ROOT = resolve(import.meta.dir, "../..");
const OUT = resolve(process.argv[3] ?? join(ROOT, "deploy/out/8453-rehearsal"));
const BUN = process.execPath;
const FOUNDRY = join(ROOT, ".tools/foundry/v1.8.6");
const PORT = Number(process.env.REHEARSAL_PORT ?? 18548);
const RPC = `http://127.0.0.1:${PORT}`;
// anvil's public test keys. They hold nothing on any real chain.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const deployer = privateKeyToAccount(KEY);
const OWNERS = [
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x90F79bf6EB2c4f870365E785982E1f101E93b906", "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
] as Address[];
const KEEPER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const WATCHERS = ["a1", "b2", "c3"].map((k) => privateKeyToAccount(`0x${k.padStart(64, "0")}`).address);
// Base's Safe 1.4.1 deployment: the proxy factory, the L2 singleton and the fallback handler.
const SAFE_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Address;
const SAFE_SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762" as Address;
const SAFE_HANDLER = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99" as Address;
// The same end as Robinhood Chain's admin term (2027-11-03 00:00 UTC), so both chains' admin rights lapse together.
const ADMIN_EXPIRY = 1_825_286_400;

const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
]);
const factoryAbi = parseAbi(["function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)"]);
const proxyCreation = parseAbiItem("event ProxyCreation(address indexed proxy, address singleton)");

const results: [string, boolean][] = [];
const check = (n: string, ok: boolean, d = "") => { results.push([n, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const work = mkdtempSync(join(tmpdir(), "canopy-base-launch-"));
/** Command output with no local paths and no fork URL, so it can be kept in the repository. */
const clean = (s: string) => s.replaceAll(realpathSync(work), "<work>").replaceAll(work, "<work>").replaceAll(ROOT, "<repo>").replaceAll(RPC, "<base fork>").replaceAll(FORK, "<base rpc>").replace(/\u001b\[[0-9;]*m/g, "");
const save = (file: string, text: string) => writeFileSync(join(OUT, file), `${clean(text).trimEnd()}\n`);
const run = (cmd: string[], cwd: string, env: Record<string, string> = {}) => {
  const p = spawnSync(cmd, { cwd, env: { ...process.env, ...env } as Record<string, string> });
  return { code: p.exitCode, out: `${p.stdout.toString()}${p.stderr.toString()}` };
};
const lines = (s: string) => s.split("\n").filter((l) => /^(PASS|FAIL|NOTE)\s/.test(l));

const anvil = spawn([join(FOUNDRY, "anvil"), "--fork-url", FORK, "--port", String(PORT), "--silent", "--no-rate-limit"], { stdout: "ignore", stderr: "ignore" });
try {
  const client = createPublicClient({ chain: base, transport: http(RPC), cacheTime: 0 }) as PublicClient;
  for (let i = 0; ; i++) {
    try { await client.getBlockNumber(); break; } catch { if (i > 120) throw new Error("anvil did not start"); await Bun.sleep(500); }
  }
  if ((await client.getChainId()) !== BASE.chainId) throw new Error("the fork is not Base");
  const forkBlock = await client.getBlockNumber();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const wallet = createWalletClient({ chain: base, transport: http(RPC), account: deployer });
  const rpc = (method: string, params: unknown[]) => client.request({ method, params } as never);

  // Three Safes, made the way the Safe app makes them, from Base's own factory and singleton.
  const makeSafe = async (salt: bigint) => {
    const init = encodeFunctionData({ abi: safeAbi, functionName: "setup", args: [OWNERS, 2n, zeroAddress, "0x", SAFE_HANDLER, zeroAddress, 0n, zeroAddress] });
    const hash = await wallet.writeContract({ address: SAFE_FACTORY, abi: factoryAbi, functionName: "createProxyWithNonce", args: [SAFE_SINGLETON, init, salt] });
    const r = await client.waitForTransactionReceipt({ hash });
    const log = r.logs.find((l) => l.address.toLowerCase() === SAFE_FACTORY.toLowerCase())!;
    return (decodeEventLog({ abi: [proxyCreation], data: log.data, topics: log.topics }).args as { proxy: Address }).proxy;
  };
  const [proposer, guardian, payments] = [await makeSafe(0xca0001n), await makeSafe(0xca0002n), await makeSafe(0xca0003n)];
  const thresholds = await Promise.all([proposer, guardian, payments].map((s) => client.readContract({ address: s, abi: safeAbi, functionName: "getThreshold" })));
  check("three stand-in Safes made from Base's Safe 1.4.1 factory, each 2 of 3", thresholds.every((t) => t === 2n), `${proposer.slice(0, 10)} ${guardian.slice(0, 10)} ${payments.slice(0, 10)}`);
  await rpc("anvil_setBalance", [KEEPER, "0x2386F26FC10000"]); // 0.01 ETH

  // The settings, from the example with the stand-ins filled in.
  const example = JSON.parse(readFileSync(join(ROOT, "deploy/settings.base.example.json"), "utf8"));
  const settings = {
    ...example, proposer, guardian, watchers: WATCHERS, planPayTo: payments, apiUrl: "https://api-base.rehearsal.invalid", keeper: KEEPER,
    deployer: deployer.address, adminExpiry: ADMIN_EXPIRY,
  };
  const settingsFile = join(work, "settings.base.json");
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  const launchEnv = readFileSync(join(ROOT, "deploy/launch.base.env.example"), "utf8")
    .replace(/^WATCHERS=.*$/m, `WATCHERS=${WATCHERS.join(",")}`).replace(/^PROPOSER_MULTISIG=.*$/m, `PROPOSER_MULTISIG=${proposer}`)
    .replace(/^GUARDIAN_MULTISIG=.*$/m, `GUARDIAN_MULTISIG=${guardian}`).replace(/^ADMIN_EXPIRY=.*$/m, `ADMIN_EXPIRY=${ADMIN_EXPIRY}`)
    .replace(/^RPC=.*$/m, `RPC=${RPC}`).replace(/^DEPLOYER=.*$/m, `DEPLOYER=${deployer.address}`);
  const launchFile = join(work, "launch.base.env");
  writeFileSync(launchFile, launchEnv);
  const deployEnv = Object.fromEntries(launchEnv.split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  save("settings.base.json", JSON.stringify(settings, null, 2));
  save("launch.base.env", launchEnv);
  check("the example settings cover the web app's Base vaults exactly", JSON.stringify(example.vaults) === JSON.stringify(CHAINS.find((c) => c.chainId === BASE.chainId)!.vaults.map((v) => v.address)));

  // 0. The launch vaults, read on the fork.
  const vaults = run([BUN, "deploy/check-vaults.ts", RPC, settingsFile], join(ROOT, "services"));
  save("0-vaults.txt", vaults.out);
  check("every launch vault passes: USDC, gates unset and abdicated, readable price, assets held", vaults.code === 0, vaults.out.trim().split("\n").at(-1));

  // 1. Preflight, with a services env for the Base stack. Its secrets are stand-ins so every line can be read.
  const servicesEnv = join(work, "services.base.env");
  writeFileSync(servicesEnv, [
    "CHAIN_ID=8453", `RPC_URL=${RPC}`, `RPC_URL_BACKUP=http://localhost:${PORT}`, "PUBLIC_URL=https://api-base.rehearsal.invalid",
    "DATABASE_URL=postgres://canopy:stand-in@db.rehearsal.invalid:5432/canopy_base?sslmode=require",
    `PLAN_TOKEN=${BASE.usdc}`, `PLAN_PAY_ADDRESS=${payments}`, `CARD_VAULTS=${settings.vaults.join(",")}`,
    ...["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "HEALTH_TOKEN", "ANTHROPIC_API_KEY"].map((k) => `${k}=rehearsal-stand-in-value`),
    "OPS_CHAT_ID=1", "FEED_URLS=https://status.base.org/history.rss", "",
  ].join("\n"));
  const pre = run([BUN, "deploy/preflight.ts", RPC, servicesEnv], join(ROOT, "services"), { SETTINGS_FILE: settingsFile, LAUNCH_ENV_FILE: launchFile });
  save("1-preflight.txt", pre.out);
  const preFails = lines(pre.out).filter((l) => l.startsWith("FAIL"));
  check("preflight passes every required check (NOTE lines are the audit and legal reminders)", pre.code === 0 && preFails.length === 0, preFails.join(" | ") || pre.out.trim().split("\n").at(-1));

  // 2. Deploy with the real script: simulated first, then broadcast, as RUNBOOK.md says.
  const forgeEnv = { ...deployEnv, FOUNDRY_BROADCAST: join(work, "broadcast"), FOUNDRY_CACHE_PATH: join(work, "cache") };
  const forge = (extra: string[]) => run([join(FOUNDRY, "forge"), "script", "script/Deploy.s.sol:Deploy", "--rpc-url", RPC, "--private-key", KEY, "--sender", deployer.address, ...extra], join(ROOT, "contracts"), forgeEnv);
  const nonce0 = await client.getTransactionCount({ address: deployer.address });
  const sim = forge([]);
  save("2-deploy-simulated.txt", sim.out.replaceAll(KEY, "<key>"));
  check("the simulated deploy runs and sends nothing", sim.code === 0 && (await client.getTransactionCount({ address: deployer.address })) === nonce0);
  const balance0 = await client.getBalance({ address: deployer.address });
  const live = forge(["--broadcast"]);
  save("2-deploy.txt", live.out.replaceAll(KEY, "<key>"));
  const runFile = join(work, "broadcast/Deploy.s.sol/8453/run-latest.json");
  check("Deploy.s.sol deployed in strict mainnet mode and checked its own wiring", live.code === 0 && existsSync(runFile), live.code ? live.out.slice(-300) : "");
  const runJson = JSON.parse(readFileSync(runFile, "utf8")) as { receipts: { gasUsed: string; effectiveGasPrice: string }[] };
  const deployGas = runJson.receipts.reduce((a, r) => a + BigInt(r.gasUsed), 0n);
  const deploySpent = balance0 - (await client.getBalance({ address: deployer.address }));
  writeFileSync(join(OUT, "broadcast-run-latest.json"), `${clean(readFileSync(runFile, "utf8")).trimEnd()}\n`);

  // 3. The files.
  const plan = run([BUN, "deploy/plan.ts", runFile, settingsFile, OUT], join(ROOT, "services"));
  save("3-plan.txt", plan.out);
  check("plan.ts wrote the deployment, services, web and registration files", plan.code === 0 && ["deployment.json", "services.env", "web-mainnet.json", "1-register-alarms.safe.json"].every((f) => existsSync(join(OUT, f))));
  const deployment = JSON.parse(readFileSync(join(OUT, "deployment.json"), "utf8"));
  // services.env is git-ignored under deploy/out, so the rehearsal keeps a copy under a name that is not. It holds addresses only.
  copyFileSync(join(OUT, "services.env"), join(OUT, "services.base.rehearsal.env.txt"));

  // 4. Verify.
  const verify = run([BUN, "deploy/verify.ts", join(OUT, "deployment.json"), RPC], join(ROOT, "services"));
  save("4-verify.txt", verify.out);
  const vLines = lines(verify.out);
  check("verify.ts: every check passes", verify.code === 0 && vLines.every((l) => l.startsWith("PASS")), `${vLines.filter((l) => l.startsWith("PASS")).length} of ${vLines.length}`);

  // 5. Register the presets: dry run, the run itself, and a second run that must skip everything.
  const keyFile = join(work, "registrar.key");
  writeFileSync(keyFile, KEY.slice(2));
  chmodSync(keyFile, 0o600);
  const reg = (extra: string[]) => run([BUN, "deploy/register-presets.ts", "--rpc", RPC, "--key-file", keyFile, "--deployment", join(OUT, "deployment.json"), ...extra], join(ROOT, "services"));
  const refused = reg([]);
  check("register-presets refuses Base without --mainnet", refused.code !== 0 && /mainnet/.test(refused.out));
  const dry = reg(["--dry-run", "--mainnet"]);
  save("5-register-dry-run.txt", dry.out);
  const total = settings.vaults.length * 6 + (settings.pausedVaults?.length ?? 0);
  check("the dry run lists every preset of every vault and sends nothing", dry.code === 0 && dry.out.includes(`dry run: ${total} to send, 0 already registered`));
  const first = reg(["--mainnet"]);
  save("5-register.txt", first.out);
  check("every preset registered", first.code === 0 && first.out.includes(`done: ${total} registered, 0 already registered`), first.out.trim().split("\n").at(-1));
  const regHashes = [...first.out.matchAll(/tx (0x[0-9a-f]{64})/g)].map((m) => m[1] as Hex);
  const regGas = (await Promise.all(regHashes.map((hash) => client.getTransactionReceipt({ hash })))).reduce((a, r) => a + r.gasUsed, 0n);
  const again = reg(["--mainnet"]);
  save("5-register-again.txt", again.out);
  check("a second run skips every preset and sends nothing", again.code === 0 && again.out.includes(`done: 0 registered, ${total} already registered`) && !again.out.includes("WARNING"));

  // 6. The web config: refused against a local fork for the app's real file, written elsewhere with --out.
  const webReal = run([BUN, "deploy/web-base-config.ts", join(OUT, "deployment.json"), RPC], join(ROOT, "services"));
  check("web-base-config refuses to fill the app's real file from a fork", webReal.code !== 0 && /local node/.test(webReal.out));
  const web = run([BUN, "deploy/web-base-config.ts", join(OUT, "deployment.json"), RPC, "--out", join(OUT, "web-mainnet.base.json")], join(ROOT, "services"));
  save("6-web-config.txt", web.out);
  check("web-base-config writes the Base web config from the deployment after verify passes", web.code === 0 && existsSync(join(OUT, "web-mainnet.base.json")));
  const appFile = JSON.parse(readFileSync(join(ROOT, "web/src/mainnet.base.json"), "utf8"));
  check("the app's Base config is still empty, so Base stays hidden", appFile.router === null && appFile.alarmBook === null);

  // What the real run costs: the gas measured here, at Base's own price today and at a busy 0.1 gwei.
  const price = await createPublicClient({ transport: http(FORK) }).getGasPrice();
  const cost = (gas: bigint) => `${formatEther(gas * price)} ETH now (${Number(price) / 1e9} gwei), ${formatEther(gas * 100_000_000n)} ETH at 0.1 gwei`;
  const summary = [
    `Base fork rehearsal of the v2 launch, forked at Base block ${forkBlock}.`,
    `Deploy: ${runJson.receipts.length} transactions, ${deployGas} gas: ${cost(deployGas)}. The fork charged ${formatEther(deploySpent)} ETH.`,
    `Registration: ${regHashes.length} presets, ${regGas} gas: ${cost(regGas)}.`,
    `Contracts: router ${deployment.router}, alarm book ${deployment.alarmBook}, adapter ${deployment.adapter}, timelock ${deployment.timelock}.`,
    `Stand-ins: deployer and registrar are anvil's first test key; proposer ${proposer}, guardian ${guardian} and payments ${payments} are 2-of-3 Safe 1.4.1 proxies made on the fork over anvil test accounts.`,
    "",
    ...results.map(([n, ok]) => `${ok ? "PASS" : "FAIL"}  ${n}`),
  ];
  save("README.txt", summary.join("\n"));
  console.log(`\n${summary.slice(0, 5).join("\n")}`);
} catch (e) {
  check("rehearsal finished", false, (e as Error).message.slice(0, 500));
} finally {
  anvil.kill();
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((x) => !x[1]).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed. Output in ${OUT.replace(ROOT, "<repo>")}`);
process.exit(failed ? 1 : 0);
