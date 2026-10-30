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

const vaultAbi = parseAbi([
  "function deposit(uint256,address) returns (uint256)",
  "function setPaused(bool)",
  "function paused() view returns (bool)",
]);
const HACK_DRAIN_WINDOW = 240;
const usdAbi = parseAbi(["function mint(address,uint256)"]);
const redeemAbi = parseAbi(["function redeem(uint256,address,address) returns (uint256)"]);
const encode = async (abi: never, functionName: string, args: unknown[]) => {
  const { encodeFunctionData } = await import("viem");
  return encodeFunctionData({ abi, functionName, args } as never);
};

/** Gives an address test stablecoin and vault shares, so a person can try the web app with their own wallet. */
async function cmdGive(who: Address) {
  const k = loadKeys();
  const s = readState();
  await send(k.deployer, { to: s.usd!, data: await encode(usdAbi as never, "mint", [addr(k.deployer), 2_000_000_000n]) });
  await send(k.deployer, { to: s.usd!, data: await encode(erc20Abi as never, "approve", [s.vault, 2_000_000_000n]) });
  await send(k.deployer, { to: s.vault!, data: await encode(vaultAbi as never, "deposit", [1_000_000_000n, who]) });
  await send(k.deployer, { to: s.usd!, data: await encode(erc20Abi as never, "transfer", [who, 100_000_000n]) });
  console.log(`${who} now holds 1,000 test vault shares and 100 tUSD`);
}

/** The real services against the live chain: a real alarm fires, and the keeper exits a real test position. */
async function cmdSmoke() {
  const k = loadKeys();
  const s = readState();
  if (!s.finished) fail("not live yet. Run: testnet.ts finish");
  await topUp(k);
  const { router, adapter, alarmBook } = loadDeployment();
  const user = addr(k.user);
  const db0 = postgres(`${PG}/postgres`);
  const name = "canopy_sepolia";
  await db0.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => fail("Postgres isn't running. Run: tools/dev-db.sh start"));
  await db0.exec(`CREATE DATABASE ${name}`);
  const db = postgres(`${PG}/${name}`);
  const startBlock = await client.getBlockNumber();

  // A unique detector per run, because an alarm can only re-fire after 24 hours.
  const detector: Detector = { kind: Kind.PAUSED, target: s.vault!, threshold: BigInt(Date.now()), window: 0, a: zero32, b: zero32 };
  const key = keyOf(detector);
  await send(k.deployer, registerTx(alarmBook, detector));
  await send(k.deployer, { to: s.usd!, data: await encode(usdAbi as never, "mint", [user, 1_100_000_000n]) });
  await send(k.user, { to: s.usd!, data: await encode(erc20Abi as never, "approve", [s.vault, 1_000_000_000n]) });
  await send(k.user, { to: s.vault!, data: await encode(vaultAbi as never, "deposit", [1_000_000_000n, user]) });
  await send(k.user, approveTx(s.vault!, router));
  await send(k.user, armTx(router, adapter, s.vault!, [key]));
  await send(k.user, planTx(s.usd!, addr(k.payTo), PLAN_AMOUNTS.months3));
  console.log("test position armed and plan paid");

  const telegram: string[] = [];
  const mock = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/sendMessage")) {
        telegram.push(((await req.json()) as { text: string }).text);
        return Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } });
      }
      return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: "t", username: "t" } });
    },
  });
  const apiPort = 18750;
  const logDir = DIR;
  const proc = spawn([BUN, "src/index.ts"], {
    cwd: join(ROOT, "services"),
    stdout: Bun.file(join(logDir, "smoke.log")),
    stderr: Bun.file(join(logDir, "smoke.err")),
    env: {
      ...process.env, ROLE: "all", PORT: String(apiPort), PUBLIC_URL: `http://127.0.0.1:${apiPort}`, DATABASE_URL: `${PG}/${name}`, CHAIN_ID: String(SEPOLIA.chainId), RPC_URL: RPC, RPC_URL_BACKUP: RPC,
      ROUTER: router, ALARM_BOOK: alarmBook, ADAPTER_4626: adapter, START_BLOCK: startBlock.toString(), PLAN_PAY_ADDRESS: addr(k.payTo), PLAN_TOKEN: s.usd, KEEPER_PRIVATE_KEY: k.keeper,
      TELEGRAM_BOT_TOKEN: "1:local", TELEGRAM_API_ROOT: `http://127.0.0.1:${mock.port}`, TELEGRAM_WEBHOOK_SECRET: "local-webhook-secret",
    },
  });
  const until = async (what: string, fn: () => Promise<boolean>, ms = 120_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await fn()) return; } catch { /* still starting */ }
      await Bun.sleep(200);
    }
    proc.kill();
    mock.stop(true);
    fail(`timed out waiting for ${what}. See ${join(logDir, "smoke.err")}`);
  };
  const shares = () => client.readContract({ address: s.vault!, abi: erc20Abi, functionName: "balanceOf", args: [user] });
  await until("the indexer", async () => (await db.query(`SELECT 1 FROM positions WHERE active`)).length === 1 && (await db.query(`SELECT 1 FROM plans`)).length === 1);
  console.log("services indexed the position and the plan");

  const before = await client.readContract({ address: s.usd!, abi: erc20Abi, functionName: "balanceOf", args: [user] });
  await send(k.deployer, { to: s.vault!, data: await encode(vaultAbi as never, "setPaused", [true]) });
  const t0 = Date.now();
  await until("the exit", async () => (await shares()) === 0n);
  const seconds = (Date.now() - t0) / 1000;
  const after = await client.readContract({ address: s.usd!, abi: erc20Abi, functionName: "balanceOf", args: [user] });
  proc.kill();
  await proc.exited;
  mock.stop(true);
  await send(k.deployer, { to: s.vault!, data: await encode(vaultAbi as never, "setPaused", [false]) });
  const errs = readFileSync(join(logDir, "smoke.err"), "utf8").trim();
  console.log(`exit paid ${(after - before) / 1_000_000n} tUSD, ${seconds.toFixed(1)}s after the pause was mined`);
  if (after - before !== 1_000_000_000n) fail("the owner was not paid in full");
  if (errs) fail(`the services logged errors:\n${errs.slice(0, 500)}`);
  console.log(`smoke test passed. Exit time: ${seconds.toFixed(1)}s`);
}

/**
 * A real drain on a fresh test vault, confirmed by a report. Two operators run as separate processes with their own databases.
 * Everything on-chain is real. Telegram, the report and Claude's label are local stand-ins.
 */
async function cmdHack() {
  const k = loadKeys();
  const s = readState();
  if (!s.finished) fail("not live yet. Run: testnet.ts finish");
  await topUp(k);
  const { router, adapter, alarmBook } = loadDeployment();
  const user = addr(k.user);
  const mint = (to: Address, amount: bigint) => encode(usdAbi as never, "mint", [to, amount]).then((data) => send(k.deployer, { to: s.usd!, data }));
  const approve = (who: Hex, vault: Address, amount: bigint) => encode(erc20Abi as never, "approve", [vault, amount]).then((data) => send(who, { to: s.usd!, data }));
  const deposit = (who: Hex, vault: Address, amount: bigint) => encode(vaultAbi as never, "deposit", [amount, addr(who)]).then((data) => send(who, { to: vault, data }));

  const vault = await deployArtifact(k.deployer, "TestAssets.sol/TestVault.json", [s.usd]);
  await mint(addr(k.deployer), 9_000_000_000n);
  await approve(k.deployer, vault, 9_000_000_000n);
  await deposit(k.deployer, vault, 9_000_000_000n);
  await mint(user, 1_100_000_000n);
  await approve(k.user, vault, 1_000_000_000n);
  await deposit(k.user, vault, 1_000_000_000n);

  const startBlock = await client.getBlockNumber();
  // The real preset, except that a 4-minute drain window gives a baseline in 2 minutes instead of 30.
  const drain: Detector = { kind: Kind.DRAIN, target: vault, threshold: 2500n, window: HACK_DRAIN_WINDOW, a: zero32, b: zero32 };
  const quorum = presetsFor(vault).find((p) => p.detector.kind === Kind.QUORUM)!.detector;
  const both: Detector = { kind: Kind.BOTH, target: vault, threshold: 0n, window: 86_400, a: keyOf(drain), b: keyOf(quorum) };
  for (const d of [drain, quorum, both]) await send(k.deployer, registerTx(alarmBook, d));
  await send(k.user, approveTx(vault, router));
  await send(k.user, armTx(router, adapter, vault, [keyOf(both)]));
  await send(k.user, planTx(s.usd!, addr(k.payTo), PLAN_AMOUNTS.months3));
  console.log("test position armed on the drain alarm");

  const db0 = postgres(`${PG}/postgres`);
  const dbs: Db[] = [];
  for (const name of ["canopy_hack_a", "canopy_hack_b"]) {
    await db0.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => fail("Postgres isn't running. Run: tools/dev-db.sh start"));
    await db0.exec(`CREATE DATABASE ${name}`);
    const db = postgres(`${PG}/${name}`);
    await migrate(db);
    // The card loop runs less often, so this has the vault on its first pass.
    await db.query(`INSERT INTO vault_follows (chat_id, target) VALUES (1,$1)`, [vault.toLowerCase()]);
    dbs.push(db);
  }
  const [dbA, dbB] = dbs as [Db, Db];

  let report = "Routine status update. All systems normal.";
  const mock = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/feed") return new Response(report);
      if (u.pathname === "/v1/messages") {
        const body = (await req.json()) as { messages: { content: string }[] };
        const verdict = body.messages[0]!.content.includes("drained") ? { label: "EXPLOIT_CONFIRMED", protocol: "Canopy", confidence: 0.97 } : { label: "IRRELEVANT", protocol: "none", confidence: 0.9 };
        return Response.json({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(verdict) }], usage: { input_tokens: 1, output_tokens: 1 } });
      }
      if (u.pathname.endsWith("/sendMessage")) return Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } });
      return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: "t", username: "t" } });
    },
  });
  const [portA, portB] = [18751, 18752];
  const local = `http://127.0.0.1:${mock.port}`;
  const launch = (name: string, port: number, db: string, extra: Record<string, string>) =>
    spawn([BUN, "src/index.ts"], {
      cwd: join(ROOT, "services"),
      stdout: Bun.file(join(DIR, `${name}.log`)),
      stderr: Bun.file(join(DIR, `${name}.err`)),
      env: {
        ...process.env, ROLE: "all", PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}`, DATABASE_URL: `${PG}/${db}`, CHAIN_ID: String(SEPOLIA.chainId),
        RPC_URL: RPC, RPC_URL_BACKUP: process.env.RPC_URL_BACKUP ?? RPC, ROUTER: router, ALARM_BOOK: alarmBook, ADAPTER_4626: adapter, START_BLOCK: startBlock.toString(),
        PLAN_PAY_ADDRESS: addr(k.payTo), PLAN_TOKEN: s.usd, WATCHERS: [k.watcher1, k.watcher2, k.watcher3].map(addr).join(","), WATCHER_PEERS: `http://127.0.0.1:${portA},http://127.0.0.1:${portB}`,
        FEED_URLS: `${local}/feed`, ANTHROPIC_API_KEY: "local", ANTHROPIC_BASE_URL: local, TELEGRAM_BOT_TOKEN: "1:local", TELEGRAM_API_ROOT: local, TELEGRAM_WEBHOOK_SECRET: "local-webhook-secret",
        LOOP_SCALE: "0.25", ...extra,
      },
    });
  const procs = [
    launch("hack-a", portA, "canopy_hack_a", { KEEPER_PRIVATE_KEY: k.keeper, WATCHER_PRIVATE_KEY: k.watcher1 }),
    launch("hack-b", portB, "canopy_hack_b", { WATCHER_PRIVATE_KEY: k.watcher2 }),
  ];
  const stop = async () => {
    for (const p of procs) p.kill();
    await Promise.all(procs.map((p) => p.exited));
    mock.stop(true);
  };
  const until = async (what: string, fn: () => Promise<boolean>, ms = 180_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await fn()) return; } catch { /* still starting */ }
      await Bun.sleep(500);
    }
    await stop();
    fail(`timed out waiting for ${what}. See ${join(DIR, "hack-a.err")} and ${join(DIR, "hack-a.log")}`);
  };
  const rows = async (db: Db, sql: string) => (await db.query(sql)).length;
  const shares = () => client.readContract({ address: vault, abi: erc20Abi, functionName: "balanceOf", args: [user] });

  await until("both operators to see the position", async () => (await rows(dbA, `SELECT 1 FROM positions WHERE active`)) === 1 && (await rows(dbB, `SELECT 1 FROM positions WHERE active`)) === 1);
  await until("the plan payment", async () => (await rows(dbA, `SELECT 1 FROM plans`)) === 1);
  await until("the risk cards", async () => (await rows(dbA, `SELECT 1 FROM risk_cards`)) === 1 && (await rows(dbB, `SELECT 1 FROM risk_cards`)) === 1);
  await until("a snapshot before the drain", async () => (await rows(dbA, `SELECT 1 FROM vault_snaps`)) >= 2 && (await rows(dbB, `SELECT 1 FROM vault_snaps`)) >= 2);
  console.log("services are watching the vault");

  const baselineDue = Number((await client.readContract({ address: alarmBook, abi: alarmBookAbi, functionName: "state", args: [keyOf(drain)] }))[2]) + HACK_DRAIN_WINDOW / 2;
  await until("a drain baseline", async () => Number((await client.getBlock()).timestamp) > baselineDue);
  await send(k.deployer, { to: alarmBook, data: await encode(alarmBookAbi as never, "checkpoint", [keyOf(drain)]) });
  console.log("drain baseline set");

  report = "Security alert: Canopy Test Vault drained by an attacker.";
  await until("both operators to label the report", async () => (await rows(dbA, `SELECT 1 FROM feed_items WHERE label='EXPLOIT_CONFIRMED'`)) === 1 && (await rows(dbB, `SELECT 1 FROM feed_items WHERE label='EXPLOIT_CONFIRMED'`)) === 1);
  await Bun.sleep(5_000);
  if ((await rows(dbA, `SELECT 1 FROM attestations`)) !== 0 || (await shares()) === 0n) fail("a report alone moved something");
  console.log("a report alone did nothing");

  const before = await client.readContract({ address: s.usd!, abi: erc20Abi, functionName: "balanceOf", args: [user] });
  await send(k.deployer, { to: vault, data: await encode(redeemAbi as never, "redeem", [8_000_000_000n, addr(k.deployer), addr(k.deployer)]) });
  const t0 = Date.now();
  console.log("80% of the vault withdrawn");
  await until("the exit", async () => (await shares()) === 0n);
  const seconds = (Date.now() - t0) / 1000;
  const after = await client.readContract({ address: s.usd!, abi: erc20Abi, functionName: "balanceOf", args: [user] });
  const signers = await dbA.query(`SELECT DISTINCT signer FROM attestations`);
  await stop();
  console.log(`exit paid ${(after - before) / 1_000_000n} tUSD, ${seconds.toFixed(1)}s after the drain was mined, with ${signers.length} watchers signing`);
  if (after - before !== 1_000_000_000n) fail("the owner was not paid in full");
  if (signers.length < 2) fail("the alarm fired without two watchers");
  const errs = ["hack-a.err", "hack-b.err"].map((f) => readFileSync(join(DIR, f), "utf8").trim()).filter(Boolean).join("\n");
  if (errs) fail(`the services logged errors:\n${errs.slice(0, 500)}`);
  console.log(`hack test passed. Exit time: ${seconds.toFixed(1)}s`);
}
