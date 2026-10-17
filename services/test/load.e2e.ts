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

const procs: ReturnType<typeof spawn>[] = [];
procs.push(spawn([join(ROOT, ".tools/foundry/v1.8.6/anvil"), "--fork-url", FORK, "--port", String(RPC_PORT), "--silent", "--no-rate-limit"], { stdout: "ignore", stderr: "ignore" }));

try {
  const client = createPublicClient({ chain: P.chain, transport: http(RPC, { timeout: 60_000 }), cacheTime: 0 });
  await waitFor("anvil", async () => (await client.getBlockNumber()) > 0n);
  const rpc = (method: string, params: unknown[]) => client.request({ method, params } as never);
  const wallet = (a: Address | typeof deployer) => createWalletClient({ chain: P.chain, transport: http(RPC, { timeout: 60_000 }), account: a });
  const artifact = (f: string) => JSON.parse(readFileSync(join(ROOT, "contracts/out", f), "utf8"));
  const send = async (from: Address, to: Address, data: Hex) => {
    const r = await client.waitForTransactionReceipt({ hash: await wallet(from).sendTransaction({ to, data, gas: 3_000_000n }) });
    if (r.status !== "success") throw new Error(`reverted to ${to}`);
  };
  const deploy = async (f: string, args: unknown[] = []) => {
    const a = artifact(f);
    const hash = await wallet(deployer).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: args as never });
    return (await client.waitForTransactionReceipt({ hash })).contractAddress as Address;
  };
  const admin = async (tx: Promise<Hex>) => client.waitForTransactionReceipt({ hash: await tx });

  const start = await client.getBlockNumber();
  const block = await client.getBlock();
  const book = await deploy("AlarmBook.sol/AlarmBook.json", [deployer.address]);
  const router = await deploy("ExitRouter.sol/ExitRouter.json", [P.stable, P.weth, P.swapRouter, book, deployer.address, deployer.address, P.feed, 90_000, block.timestamp + 31_536_000n]);
  const adapter = await deploy("ERC4626Adapter.sol/ERC4626Adapter.json", [router]);
  const pausable = await deploy("Mocks.sol/MockPausable.json");
  await admin(wallet(deployer).writeContract({ address: router, abi: routerAbi, functionName: "setAdapter", args: [adapter, true] }));
  await rpc("anvil_setBalance", [keeper, ETH]);

  const detector = { kind: 2, target: pausable, threshold: 0n, window: 0, a: `0x${"00".repeat(32)}` as Hex, b: `0x${"00".repeat(32)}` as Hex };
  await admin(wallet(deployer).writeContract({ address: book, abi: alarmBookAbi, functionName: "register", args: [detector] }));
  const key = await client.readContract({ address: book, abi: alarmBookAbi, functionName: "keyOf", args: [detector] });

  // Every position shares one alarm, so they all come due in the same moment.
  const owners = Array.from({ length: COUNT }, (_, i) => keccak256(toHex(`load-${i}`)).slice(0, 42) as Address);
  const shares = (w: Address) => client.readContract({ address: VAULT, abi: erc20Abi, functionName: "balanceOf", args: [w] });
  const stable = (w: Address) => client.readContract({ address: P.stable, abi: erc20Abi, functionName: "balanceOf", args: [w] });
  await rpc("anvil_impersonateAccount", [WHALE]);
  await rpc("anvil_setBalance", [WHALE, ETH]);
  const each = (await shares(WHALE)) / BigInt(COUNT * 2);
  const t0 = Date.now();
  for (let i = 0; i < owners.length; i += 16) {
    await Promise.all(owners.slice(i, i + 16).map(async (o) => {
      await rpc("anvil_impersonateAccount", [o]);
      await rpc("anvil_setBalance", [o, ETH]);
    }));
    for (const o of owners.slice(i, i + 16)) {
      await send(WHALE, VAULT, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [o, each] }));
      const a = approveTx(VAULT, router);
      await send(o, a.to, a.data);
      const t = armTx(router, adapter, VAULT, [key]);
      await send(o, t.to, t.data);
    }
  }
  console.log(`  armed ${COUNT} positions in ${((Date.now() - t0) / 1000).toFixed(0)}s, each holding ${each} shares`);

  const adminDb = postgres(`${PG}/postgres`);
  await adminDb.exec(`DROP DATABASE IF EXISTS canopy_load WITH (FORCE)`);
  await adminDb.exec(`CREATE DATABASE canopy_load`);
  const db = postgres(`${PG}/canopy_load`);

  const logDir = process.env.TMPDIR ?? "/tmp/";
  const common = {
    ...process.env, PUBLIC_URL: "http://127.0.0.1:18453", CHAIN_ID: String(P.chain.id), RPC_URL: RPC, RPC_URL_BACKUP: RPC, ROUTER: router, ALARM_BOOK: book, ADAPTER_4626: adapter,
    START_BLOCK: (start + 1n).toString(), PLAN_PAY_ADDRESS: PAY_TO, PLAN_TOKEN: P.stable, CARD_VAULTS: VAULT, TELEGRAM_BOT_TOKEN: "1:local",
    TELEGRAM_WEBHOOK_SECRET: "local-webhook-secret", DATABASE_URL: `${PG}/canopy_load`, KEEPER_PAID_ONLY: "false",
  };
  const launch = (role: string, env: Record<string, string> = {}) => {
    for (const ext of ["log", "err"]) rmSync(`${logDir}load-${role}.${ext}`, { force: true });
    procs.push(spawn([BUN, "src/index.ts"], { cwd: join(ROOT, "services"), env: { ...common, ...env, ROLE: role }, stdout: Bun.file(`${logDir}load-${role}.log`), stderr: Bun.file(`${logDir}load-${role}.err`) }));
  };
  launch("indexer");
  launch("keeper", { KEEPER_PRIVATE_KEY: keeperKey });
  check("the indexer picked up every position", await waitFor("positions", async () => (await db.query(`SELECT 1 FROM positions WHERE active`)).length === COUNT));

  // From here on blocks arrive every 2 seconds, as they do on Base.
  await rpc("evm_setIntervalMining", [P.blockSec]);
  const nonce0 = await client.getTransactionCount({ address: keeper });
  const before = await stable(owners[0]!);
  const pauseTx = await wallet(deployer).sendTransaction({ to: pausable, data: encodeFunctionData({ abi: artifact("Mocks.sol/MockPausable.json").abi, functionName: "setPaused", args: [true] }) });
  const pause = await client.waitForTransactionReceipt({ hash: pauseTx });
  const pausedAt = Number((await client.getBlock({ blockNumber: pause.blockNumber })).timestamp);
  console.log(`  alarm condition set at block ${pause.blockNumber}`);

  const exitedSoFar = async () => parseEventLogs({ abi: routerAbi, eventName: "Exited", logs: await client.getLogs({ address: router, fromBlock: pause.blockNumber, toBlock: "latest" }) });
  let lastLog = Date.now();
  const allOut = await waitFor("exits", async () => {
    const n = (await exitedSoFar()).length;
    if (Date.now() - lastLog > 30_000) { lastLog = Date.now(); console.log(`  ${n} of ${COUNT} exited`); }
    return n >= COUNT;
  }, TIMEOUT_MS);

  const logs = await exitedSoFar();
  const times = new Map<bigint, number>();
  for (const b of new Set(logs.map((l) => l.blockNumber))) times.set(b, Number((await client.getBlock({ blockNumber: b })).timestamp));
  const waits = logs.map((l) => times.get(l.blockNumber)! - pausedAt).sort((a, b) => a - b);
  const txs = [...new Set(logs.map((l) => l.transactionHash))];
  const receipts = await Promise.all(txs.map((hash) => client.getTransactionReceipt({ hash })));
  const gas = receipts.reduce((s, r) => s + r.gasUsed, 0n);
  const sent = (await client.getTransactionCount({ address: keeper })) - nonce0;

  check("every position exited", allOut, `${logs.length} of ${COUNT}`);
  check("no owner kept shares", (await Promise.all(owners.map(shares))).every((s) => s === 0n));
  check("the owner was paid", (await stable(owners[0]!)) > before);
  check("the router holds nothing", (await stable(router)) === 0n);
  console.log(`\npositions ${COUNT}`);
  const [, firedAt] = await client.readContract({ address: book, abi: alarmBookAbi, functionName: "state", args: [key] });
  const [queued] = await db.query<{ at: string }>(`SELECT min(created_at) AS at FROM jobs WHERE kind='exit'`);
  console.log(`alarm fired on chain ${Number(firedAt) - pausedAt}s and jobs queued ${Number(queued!.at) - pausedAt}s after the alarm condition`);
  console.log(`first exit ${waits[0]}s, median ${pct(waits, 0.5)}s, 95% ${pct(waits, 0.95)}s, last ${waits.at(-1)}s after the alarm condition`);
  console.log(`keeper sent ${sent} transactions, ${txs.length} carried exits, ${gas} gas in all, ${gas / BigInt(Math.max(1, logs.length))} per exit, most in one transaction ${Math.max(...receipts.map((r) => parseEventLogs({ abi: routerAbi, eventName: "Exited", logs: r.logs }).length))}`);
  const errs = readFileSync(`${logDir}load-keeper.err`, "utf8").trim().split("\n").filter(Boolean);
  check("the keeper logged no errors", errs.length === 0);
  console.log(`keeper error lines ${errs.length}${errs.length ? `: ${errs.slice(0, 2).join(" | ").slice(0, 300)}` : ""}`);
} catch (e) {
  check("run finished", false);
  console.log((e as Error).message.slice(0, 600));
} finally {
  for (const p of procs) p.kill();
}
const failed = results.filter((x) => !x[1]);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
