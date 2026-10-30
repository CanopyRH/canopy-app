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

/** Keeps every role able to pay for its next step, so a run never stalls halfway. */
async function topUp(k: Keys) {
  for (const r of FUNDED_ROLES) {
    if ((await client.getBalance({ address: addr(k[r]) })) < ROLE_FLOOR) await send(k.deployer, { to: addr(k[r]), value: ROLE_TOPUP });
  }
}

/** Gas for the run, plus a top-up for each role that can't yet pay its own way. */
async function neededFor(k: Keys) {
  let total = RUN_GAS;
  for (const r of FUNDED_ROLES) {
    if ((await client.getBalance({ address: addr(k[r]) })) < ROLE_FLOOR) total += ROLE_TOPUP;
  }
  return total;
}

const settingsFor = (k: Keys, s: State, adminExpiry: number): Settings => ({
  chainId: SEPOLIA.chainId, proposer: addr(k.proposer), guardian: addr(k.guardian), stable: s.usd!, weth: SEPOLIA.weth, swapRouter: SEPOLIA.swapRouter,
  stableFeed: SEPOLIA.usdcFeed, heartbeat: 90_000, adminExpiry, watchers: [addr(k.watcher1), addr(k.watcher2), addr(k.watcher3)], vaults: [s.vault!],
  allowEoaAdmin: true, testTimelockDelay: TIMELOCK_SECONDS,
});

const loadDeployment = () => JSON.parse(readFileSync(join(planDir, "deployment.json"), "utf8")) as Deployment & { settings: Settings };
const calls = (f: string) => (JSON.parse(readFileSync(join(planDir, f), "utf8")) as { transactions: Call[] }).transactions;

async function runVerify(stage: "deployed" | "live") {
  const { settings, ...d } = loadDeployment();
  const checks = await verifyDeployment(client, d, settings, stage);
  const bad = checks.filter((c) => !c.ok);
  for (const c of bad) console.error(`FAIL  ${c.name}  ${c.detail ?? ""}`);
  if (bad.length) fail("verifier failed. Do not use this deployment.");
  console.log(`verifier: all ${checks.length} checks passed (${stage})`);
}

async function cmdKeys() {
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(keysFile)) {
    const keys = Object.fromEntries(ROLES.map((r) => [r, generatePrivateKey()]));
    writeFileSync(keysFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
    chmodSync(keysFile, 0o600);
  }
  const k = loadKeys();
  console.log(`Test deployer address: ${addr(k.deployer)}`);
  console.log(`Send it at least ${formatEther(await neededFor(k))} Base Sepolia ETH, then run: testnet.ts deploy`);
  console.log(`These are throwaway test keys, in ${keysFile}. Never send real funds to them.`);
}

async function cmdStatus() {
  const k = loadKeys();
  const s = readState();
  const bal = await client.getBalance({ address: addr(k.deployer) });
  console.log(`deployer ${addr(k.deployer)} holds ${formatEther(bal)} ETH (needs ${formatEther(await neededFor(k))})`);
  if (s.scheduledAt && !s.finished) {
    const now = Number((await client.getBlock()).timestamp);
    const left = s.scheduledAt + TIMELOCK_SECONDS - now;
    console.log(left > 0 ? `timelock: ${left} seconds left` : "timelock: ready. Run: testnet.ts finish");
  }
  console.log(s.finished ? "deployment: live" : s.plan ? "deployment: waiting on timelock" : "deployment: not started");
}

/** Moves test ETH to the same address on Base Sepolia, for faucets that only pay on Ethereum Sepolia. */
async function cmdBridge() {
  const k = loadKeys();
  const l1 = createPublicClient({ chain: sepolia, transport: http(L1_RPC), cacheTime: 0 });
  if ((await l1.getChainId()) !== sepolia.id) fail("this RPC is not Ethereum Sepolia");
  const bal = await l1.getBalance({ address: addr(k.deployer) });
  const needed = (await neededFor(k)) + L1_GAS;
  if (bal <= needed) fail(`deployer holds ${formatEther(bal)} ETH on Ethereum Sepolia and needs over ${formatEther(needed)}`);
  const hash = await createWalletClient({ chain: sepolia, transport: http(L1_RPC), account: privateKeyToAccount(k.deployer) }).writeContract({
    address: L1_BRIDGE, abi: parseAbi(["function depositETH(uint32,bytes) payable"]), functionName: "depositETH", args: [200_000, "0x"], value: bal - L1_GAS,
  });
  const r = await l1.waitForTransactionReceipt({ hash });
  if (r.status !== "success") fail(`bridge transaction reverted: ${hash}`);
  console.log(`bridged ${formatEther(bal - L1_GAS)} ETH to Base Sepolia. It arrives in a few minutes. Check with: testnet.ts status`);
}

async function cmdDeploy() {
  const k = loadKeys();
  const s = readState();
  if (s.plan) fail("already deployed. Run: testnet.ts status");
  if ((await client.getChainId()) !== SEPOLIA.chainId) fail("this RPC is not Base Sepolia");
  const bal = await client.getBalance({ address: addr(k.deployer) });
  const needed = await neededFor(k);
  if (bal < needed) fail(`deployer holds ${formatEther(bal)} ETH and needs ${formatEther(needed)}`);

  await topUp(k);
  console.log("funded test roles");
  s.usd = await deployArtifact(k.deployer, "TestAssets.sol/TestUSD.json");
  s.vault = await deployArtifact(k.deployer, "TestAssets.sol/TestVault.json", [s.usd]);
  saveState(s);
  console.log(`test stablecoin ${s.usd}, test vault ${s.vault}`);

  const startBlock = Number(await client.getBlockNumber());
  const adminExpiry = Number((await client.getBlock()).timestamp) + 200 * 86_400;
  const settings = settingsFor(k, s, adminExpiry);
  const timelock = await deployArtifact(k.deployer, "TestAssets.sol/TestTimelock.json", [settings.proposer, TIMELOCK_SECONDS]);
  const alarmBook = await deployArtifact(k.deployer, "AlarmBook.sol/AlarmBook.json", [timelock]);
  const router = await deployArtifact(k.deployer, "ExitRouter.sol/ExitRouter.json", [
    settings.stable, settings.weth, settings.swapRouter, alarmBook, timelock, settings.guardian, settings.stableFeed, settings.heartbeat, adminExpiry,
  ]);
  const adapter = await deployArtifact(k.deployer, "ERC4626Adapter.sol/ERC4626Adapter.json", [router]);
  writePlan({ timelock, alarmBook, router, adapter, startBlock }, settings, planDir);
  s.plan = true;
  saveState(s);
  await runVerify("deployed");
  for (const c of calls("1-schedule.safe.json")) await send(k.proposer, c);
  s.scheduledAt = Number((await client.getBlock()).timestamp);
  saveState(s);
  console.log(`admin setup scheduled. Run testnet.ts finish after ${TIMELOCK_SECONDS} seconds.`);
}

async function cmdFinish() {
  const k = loadKeys();
  const s = readState();
  if (!s.scheduledAt) fail("nothing scheduled yet. Run: testnet.ts deploy");
  if (!s.finished) {
    const now = Number((await client.getBlock()).timestamp);
    const left = s.scheduledAt! + TIMELOCK_SECONDS - now;
    if (left > 0) fail(`the timelock has ${left} seconds left`);
    await topUp(k);
    for (const c of calls("2-execute-after-delay.safe.json")) await send(k.proposer, c);
    await runVerify("live");
    // A drain alarm needs a non-empty vault to measure from.
    await send(k.deployer, { to: s.usd!, data: await encode(usdAbi as never, "mint", [addr(k.deployer), 1_000_000_000n]) });
    await send(k.deployer, { to: s.usd!, data: await encode(erc20Abi as never, "approve", [s.vault, 1_000_000_000n]) });
    await send(k.deployer, { to: s.vault!, data: await encode(vaultAbi as never, "deposit", [1_000_000_000n, addr(k.deployer)]) });
    for (const c of calls("3-register-alarms.safe.json")) await send(k.deployer, c);
    s.finished = true;
    saveState(s);
  }
  const { router, adapter, alarmBook } = loadDeployment();
  writeFileSync(process.env.WEB_DEPLOYMENT_FILE ?? join(ROOT, "web/src/deployment.json"), `${JSON.stringify({
    chainId: SEPOLIA.chainId, chainHex: "0x14a34", chainName: "Base Sepolia", rpcUrl: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", router, adapter, alarmBook, planPayTo: addr(k.payTo), planToken: s.usd,
    vaults: [{ address: s.vault, name: "Canopy Test Vault", asset: "tUSD" }],
  }, null, 2)}\n`);
  console.log("live on Base Sepolia. The web app now points at this deployment; rebuild it to use it.");
}
