/**
 * Rehearses the real launch sequence on a local fork of Robinhood Chain or Base, in strict mainnet mode.
 * Start: bun test/deploy.e2e.ts <rpc url> [timelock delay in seconds, default 0]. Nothing leaves the local fork.
 */
import { spawn, spawnSync } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { base, robinhood } from "viem/chains";
import { erc20Abi, routerAbi } from "../src/chain/abi";
import { BASE, chainParts, ROBINHOOD } from "../src/chain/addresses";
import { presetsFor } from "../src/api/presets";
import { readBroadcast, writePlan, type Call, type Settings } from "../deploy/plan";
import { verifyDeployment } from "../deploy/verify";
import { CONFIG } from "../../web/src/config";
import { approveTx, armTx, exitTx } from "../../web/src/tx";

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
    PROPOSER_MULTISIG: proposer, GUARDIAN_MULTISIG: guardian, STABLE_FEED_HEARTBEAT: "90000", ADMIN_EXPIRY: String(adminExpiry), TIMELOCK_DELAY: String(DELAY),
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

  // Deploy.
  const done = forge(deployEnv);
  if (done.exitCode !== 0) throw new Error(done.stderr.toString().slice(-500) + done.stdout.toString().slice(-500));
  check("the script deployed in strict mainnet mode", existsSync(run));
  const d = readBroadcast(run);
  const out = join(work, "plan");
  writePlan(d, settings, out);
  const fails = (c: { ok: boolean; name: string }[]) => c.filter((x) => !x.ok).map((x) => x.name);
  const v1 = await verifyDeployment(client, d, settings, "deployed");
  check("the verifier passes straight after deploy", fails(v1).length === 0, `${v1.length} checks ${fails(v1).join("; ")}`.trim());

  const first = DELAY === 0 ? "1-admin-setup.safe.json" : "1-schedule.safe.json";
  check("a stranger cannot start the admin setup", !(await tx(HOLDER, (JSON.parse(readFileSync(join(out, first), "utf8")) as { transactions: Call[] }).transactions[0]!)));
  if (DELAY === 0) {
    const setup = await batch(proposer, join(out, first));
    check("the multisig applied the admin setup in one batch", setup.ok === setup.total && setup.total === 8, `${setup.ok} of ${setup.total}`);
  } else {
    const sched = await batch(proposer, join(out, first));
    check("the multisig scheduled the admin setup", sched.ok === sched.total && sched.total === 4, `${sched.ok} of ${sched.total}`);
    const early = await batch(proposer, join(out, "2-execute-after-delay.safe.json"));
    check("nothing can execute before the delay", early.ok === 0);
    await rpc("evm_increaseTime", [DELAY]);
    await rpc("evm_mine", []);
    const exec = await batch(proposer, join(out, "2-execute-after-delay.safe.json"));
    check("the multisig executed after the delay", exec.ok === exec.total, `${exec.ok} of ${exec.total}`);
    const replay = await batch(proposer, join(out, "2-execute-after-delay.safe.json"));
    check("execution cannot be replayed", replay.ok === 0);
  }
  const v2 = await verifyDeployment(client, d, settings, "live");
  check("the verifier passes at go-live", fails(v2).length === 0, `${v2.length} checks ${fails(v2).join("; ")}`.trim());

  const presets = await batch(proposer, join(out, `${DELAY === 0 ? 2 : 3}-register-alarms.safe.json`));
  check("alarms registered for every launch vault", presets.ok === presets.total, `${presets.ok} of ${presets.total} across ${vaults.length} vaults`);

  // Tampering must be caught.
  const badGuardian = await verifyDeployment(client, d, { ...settings, guardian: proposer }, "live");
  check("the verifier catches a wrong guardian", fails(badGuardian).includes("Router guardian"));
  const swapped = await verifyDeployment(client, { ...d, router: d.alarmBook, alarmBook: d.router }, settings, "live").catch(() => null);
  check("the verifier catches swapped contracts", swapped === null || fails(swapped).length > 0);
  const clean = await rpc("evm_snapshot", []);
  await rpc("anvil_setCode", [d.adapter, (await client.getCode({ address: chainParts(chainId).morpho }))!]);
  const badCode = await verifyDeployment(client, d, settings, "live").catch(() => null);
  check("the verifier catches altered bytecode", badCode === null || fails(badCode).some((x) => x.includes("bytecode")));
  await rpc("evm_revert", [clean]);
  check("the verifier passes again once the tampering is undone", fails(await verifyDeployment(client, d, settings, "live")).length === 0);

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
