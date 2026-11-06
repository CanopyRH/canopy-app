/**
 * Rehearses the real launch sequence on a local fork of Robinhood Chain or Base, in strict mainnet mode.
 * Start: bun test/deploy.e2e.ts <rpc url> [timelock delay in seconds, default 0]. Nothing leaves the local fork.
 */
import { spawn, spawnSync } from "bun";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { base, robinhood } from "viem/chains";
import { alarmBookAbi, erc20Abi, routerAbi } from "../src/chain/abi";
import { BASE, chainParts, ROBINHOOD } from "../src/chain/addresses";
import { presetsFor } from "../src/api/presets";
import { delayOf, readBroadcast, writePlan, type Call, type Settings } from "../deploy/plan";
import { verifyDeployment } from "../deploy/verify";
import { CONFIG } from "../../web/src/config";
import { approveTx, armTx, exitTx } from "../../web/src/tx";

const timelockAbi = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 salt) returns (bytes32)",
  "function execute(address target, uint256 value, bytes data, bytes32 salt) payable returns (bytes)",
]);

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
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const WATCHERS: Address[] = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000a3"];

const results: boolean[] = [];
const check = (n: string, ok: boolean, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const work = mkdtempSync(join(tmpdir(), "canopy-deploy-"));
const anvil = spawn([join(ROOT, ".tools/foundry/v1.8.6/anvil"), "--fork-url", FORK, "--port", String(PORT), "--silent", "--no-rate-limit"], { stdout: "ignore", stderr: "ignore" });

try {
  const probe = createPublicClient({ transport: http(RPC) });
  for (let i = 0; ; i++) {
    try { await probe.getBlockNumber(); break; } catch { if (i > 120) throw new Error("anvil did not start"); await Bun.sleep(500); }
  }
  const chainId = await probe.getChainId();
  const C = CHAINS[chainId];
  if (!C) throw new Error(`no rehearsal profile for chain ${chainId}`);
  if (C.vault.toLowerCase() !== (CONFIG.vaults[0]!.address as string).toLowerCase() && chainId === CONFIG.chainId) throw new Error("the web app's first vault changed, so update this rehearsal");
  const HOLDER = C.holder, VAULT = C.vault;
  console.log(`rehearsing on ${C.chain.name}, timelock delay ${DELAY}s`);
  const client = createPublicClient({ chain: C.chain, transport: http(RPC), cacheTime: 0 }) as PublicClient;
  const rpc = (method: string, params: unknown[]) => client.request({ method, params } as never);
  const tx = async (from: Address, c: { to: Address; data: Hex }) => {
    await rpc("anvil_impersonateAccount", [from]);
    await rpc("anvil_setBalance", [from, "0x56BC75E2D63100000"]);
    const hash = await createWalletClient({ chain: C.chain, transport: http(RPC), account: from }).sendTransaction({ to: c.to, data: c.data, gas: 3_000_000n, chain: C.chain } as never);
    return (await client.waitForTransactionReceipt({ hash })).status === "success";
  };
  const batch = async (from: Address, file: string) => {
    const calls = (JSON.parse(readFileSync(file, "utf8")) as { transactions: Call[] }).transactions;
    let ok = 0;
    for (const c of calls) if (await tx(from, c)) ok++;
    return { ok, total: calls.length };
  };

  const adminOf = parseAbi(["function owner() view returns (address)", "function curator() view returns (address)"]);
  const proposer = await client.readContract({ address: C.proposerOf, abi: adminOf, functionName: C.admin } as never) as Address;
  const guardian = await client.readContract({ address: C.guardianOf, abi: adminOf, functionName: C.admin } as never) as Address;
  check("the stand-in multisigs are contracts", ((await client.getCode({ address: proposer })) ?? "0x").length > 2 && ((await client.getCode({ address: guardian })) ?? "0x").length > 2);
  const block = await client.getBlock();
  const adminExpiry = Number(block.timestamp) + 365 * 86_400;
  const vaults = chainId === CONFIG.chainId ? CONFIG.vaults.map((v) => v.address as Address) : [VAULT];
  const settings: Settings = {
    chainId, proposer, guardian, stable: C.stable, weth: C.weth, swapRouter: C.swapRouter, stableFeed: C.feed,
    heartbeat: 90_000, adminExpiry, timelockDelay: DELAY, watchers: WATCHERS, vaults,
  };
  const deployEnv: Record<string, string> = {
    ...(process.env as Record<string, string>), STABLE: C.stable, WETH: C.weth, SWAP_ROUTER: C.swapRouter, STABLE_FEED: C.feed,
    WATCHERS: WATCHERS.join(","), PROPOSER_MULTISIG: proposer, GUARDIAN_MULTISIG: guardian, STABLE_FEED_HEARTBEAT: "90000", ADMIN_EXPIRY: String(adminExpiry), TIMELOCK_DELAY: String(DELAY),
    FOUNDRY_BROADCAST: join(work, "broadcast"), FOUNDRY_CACHE_PATH: join(work, "cache-script"),
  };
  const forge = (env: Record<string, string>) => spawnSync([FORGE, "script", "script/Deploy.s.sol:Deploy", "--rpc-url", RPC, "--broadcast", "--private-key", KEY], { cwd: join(ROOT, "contracts"), env });
  const run = join(work, `broadcast/Deploy.s.sol/${chainId}/run-latest.json`);

  // Refusals come first, and must leave nothing behind.
  const nonce0 = await client.getTransactionCount({ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" });
  const refused = forge({ ...deployEnv, PROPOSER_MULTISIG: "0x00000000000000000000000000000000000000e0", ALLOW_EOA_ADMIN: "true" });
  check("mainnet refuses a personal wallet as admin, even with the override", refused.exitCode !== 0 && !existsSync(run));
  check("the refused run deployed nothing", (await client.getTransactionCount({ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" })) === nonce0);
  const lateFeed = forge({ ...deployEnv, ADMIN_EXPIRY: String(Number(block.timestamp) + 86_400) });
  check("a too-short admin life is refused", lateFeed.exitCode !== 0 && !existsSync(run));
  const oneWatcher = forge({ ...deployEnv, WATCHERS: WATCHERS[0]! });
  check("a single watcher is refused, because the quorum presets need two", oneWatcher.exitCode !== 0 && !existsSync(run));
  const repeated = forge({ ...deployEnv, WATCHERS: [WATCHERS[0], WATCHERS[0], WATCHERS[1]].join(",") });
  check("a repeated watcher is refused", repeated.exitCode !== 0 && !existsSync(run));
  const adminWatcher = forge({ ...deployEnv, WATCHERS: [WATCHERS[0], proposer].join(",") });
  check("an admin as a watcher is refused", adminWatcher.exitCode !== 0 && !existsSync(run));

  // Deploy.
  const done = forge(deployEnv);
  if (done.exitCode !== 0) throw new Error(done.stderr.toString().slice(-500) + done.stdout.toString().slice(-500));
  check("the script deployed in strict mainnet mode", existsSync(run));
  const d = readBroadcast(run);
  const out = join(work, "plan");
  writePlan(d, settings, out);
  const fails = (c: { ok: boolean; name: string }[]) => c.filter((x) => !x.ok).map((x) => x.name);
  const v1 = await verifyDeployment(client, d, settings);
  check("the verifier passes straight after deploy, with nothing left to set up", fails(v1).length === 0, `${v1.length} checks ${fails(v1).join("; ")}`.trim());
  check("the plan has no admin batch, only the alarm registration", JSON.stringify(readdirSync(out).filter((f) => f.endsWith(".safe.json"))) === JSON.stringify(["1-register-alarms.safe.json"]));
  check("the router allowed the adapter from its constructor", await client.readContract({ address: d.router, abi: routerAbi, functionName: "adapterAllowed", args: [d.adapter] }) === true);
  check("every watcher is active from the deploy", (await Promise.all(WATCHERS.map((w) => client.readContract({ address: d.alarmBook, abi: alarmBookAbi, functionName: "isWatcher", args: [w] })))).every(Boolean));

  // Registering the presets is open to anyone: a plain holder does it here, not the multisig.
  const presets = await batch(HOLDER, join(out, "1-register-alarms.safe.json"));
  check("anyone can register the alarms for every launch vault", presets.ok === presets.total && presets.total === vaults.length * 6, `${presets.ok} of ${presets.total} across ${vaults.length} vaults`);
  const again = await batch(HOLDER, join(out, "1-register-alarms.safe.json"));
  check("registering them again changes nothing", again.ok === again.total);

  // The admin's only jobs now are adapters, the guardian and the watcher list, and they still go through the Timelock.
  const stranger = { to: d.alarmBook, data: encodeFunctionData({ abi: alarmBookAbi, functionName: "setWatcher", args: [HOLDER, BigInt(Number(block.timestamp) + 30 * 86_400)] }) };
  check("a stranger cannot change the watcher list", !(await tx(HOLDER, stranger)));
  const salt = `0x${"5a".repeat(32)}` as Hex;
  const newWatcher = encodeFunctionData({ abi: alarmBookAbi, functionName: "setWatcher", args: [A(0xe1), BigInt(Number(block.timestamp) + 30 * 86_400)] });
  const viaTimelock = { schedule: { to: d.timelock, data: encodeFunctionData({ abi: timelockAbi, functionName: "schedule", args: [d.alarmBook, 0n, newWatcher, salt] }) }, execute: { to: d.timelock, data: encodeFunctionData({ abi: timelockAbi, functionName: "execute", args: [d.alarmBook, 0n, newWatcher, salt] }) } };
  check("a stranger cannot schedule through the Timelock", !(await tx(HOLDER, viaTimelock.schedule)));
  check("the proposer schedules a watcher", await tx(proposer, viaTimelock.schedule));
  if (delayOf(settings) > 0) {
    check("nothing can execute before the delay", !(await tx(proposer, viaTimelock.execute)));
    await rpc("evm_increaseTime", [DELAY]);
    await rpc("evm_mine", []);
  }
  check("the proposer applies it", await tx(proposer, viaTimelock.execute));
  check("execution cannot be replayed", !(await tx(proposer, viaTimelock.execute)));
  const since = await client.readContract({ address: d.alarmBook, abi: alarmBookAbi, functionName: "watcherSince", args: [A(0xe1)] });
  const nowTs = (await client.getBlock()).timestamp;
  check("a new watcher waits two days before it can sign", since >= nowTs + 2n * 86_400n - 5n && !(await client.readContract({ address: d.alarmBook, abi: alarmBookAbi, functionName: "isWatcher", args: [A(0xe1)] })));
  const extra = await verifyDeployment(client, d, settings);
  check("the verifier flags a watcher nobody planned for", fails(extra).includes("No watcher beyond the intended ones"));
  const removeIt = encodeFunctionData({ abi: alarmBookAbi, functionName: "setWatcher", args: [A(0xe1), 0n] });
  const removeVia = (fn: "schedule" | "execute", salt2: Hex) => ({ to: d.timelock, data: encodeFunctionData({ abi: timelockAbi, functionName: fn, args: [d.alarmBook, 0n, removeIt, salt2] }) });
  const salt2 = `0x${"5b".repeat(32)}` as Hex;
  await tx(proposer, removeVia("schedule", salt2));
  if (delayOf(settings) > 0) {
    await rpc("evm_increaseTime", [DELAY]);
    await rpc("evm_mine", []);
  }
  check("the proposer removes it again, at once", await tx(proposer, removeVia("execute", salt2)));
  check("the verifier passes again", fails(await verifyDeployment(client, d, settings)).length === 0);

  // Tampering must be caught.
  const badGuardian = await verifyDeployment(client, d, { ...settings, guardian: proposer });
  check("the verifier catches a wrong guardian", fails(badGuardian).includes("Router guardian"));
  const swapped = await verifyDeployment(client, { ...d, router: d.alarmBook, alarmBook: d.router }, settings).catch(() => null);
  check("the verifier catches swapped contracts", swapped === null || fails(swapped).length > 0);
  const clean = await rpc("evm_snapshot", []);
  await rpc("anvil_setCode", [d.adapter, (await client.getCode({ address: chainParts(chainId).morpho }))!]);
  const badCode = await verifyDeployment(client, d, settings).catch(() => null);
  check("the verifier catches altered bytecode", badCode === null || fails(badCode).some((x) => x.includes("bytecode")));
  await rpc("evm_revert", [clean]);
  const badWatchers = await verifyDeployment(client, d, { ...settings, watchers: [WATCHERS[0]!, WATCHERS[1]!, A(0xe2)] });
  check("the verifier catches a watcher list that differs from the settings", fails(badWatchers).length > 0);
  check("the verifier passes again once the tampering is undone", fails(await verifyDeployment(client, d, settings)).length === 0);

  // The live system works for a real holder, and the admin can't get in the way.
  check("an outsider cannot touch the admin", !(await tx(HOLDER, { to: d.router, data: encodeFunctionData({ abi: routerAbi, functionName: "setAdapter", args: [HOLDER, true] }) })));
  const quorumKey = presetsFor(VAULT)[1]!.key;
  await tx(HOLDER, approveTx(VAULT, d.router));
  const arm = armTx(d.router, d.adapter, VAULT, [quorumKey]);
  check("a real holder armed through the web app's transaction", await tx(HOLDER, arm));
  check("the guardian can pause new arming", await tx(guardian, { to: d.router, data: encodeFunctionData({ abi: routerAbi, functionName: "setArmingPaused", args: [true] }) }));
  check("a paused router refuses new arming", !(await tx(HOLDER, arm)));
  const before = await client.readContract({ address: C.stable, abi: erc20Abi, functionName: "balanceOf", args: [HOLDER] });
  const pos = await client.readContract({ address: d.router, abi: routerAbi, functionName: "positionId", args: [HOLDER, d.adapter, VAULT, 0n] });
  check("the pause does not block Exit Now", await tx(HOLDER, exitTx(d.router, pos)));
  const after = await client.readContract({ address: C.stable, abi: erc20Abi, functionName: "balanceOf", args: [HOLDER] });
  check("the owner was paid", after > before, `${(after - before) / 1_000_000n} ${C.symbol}`);
} catch (e) {
  check("rehearsal finished", false, (e as Error).message.slice(0, 500));
} finally {
  anvil.kill();
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
