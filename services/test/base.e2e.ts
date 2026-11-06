/**
 * Full run on a local fork of Base: real contracts, a real USDC vault, a real holder.
 * Plan payment -> indexer -> watchers sign -> quorum fires -> keeper exits.
 * Start: bun test/base.e2e.ts <base rpc url>. Nothing leaves the local fork.
 */
import { spawn } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createPublicClient, createWalletClient, encodeFunctionData, getContractAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { alarmBookAbi, erc20Abi, routerAbi } from "../src/chain/abi";
import { BASE } from "../src/chain/addresses";
import { createApi } from "../src/api/server";
import { applyPayment, applyRegistered, applyRouterLog, decodeFired, syncLogs } from "../src/indexer/indexer";
import { drainExits, onFired, type KeeperDeps } from "../src/keeper/keeper";
import { cardText, readCard } from "../src/risk/card";
import { migrate, type Db } from "../src/store/db";
import { repo } from "../src/store/repo";
import { maybeAttest, quorumCall } from "../src/watcher/watcher";
import type { Signal } from "../src/detectors";
import { approveTx, armTx, disarmAllTx, exitTx, planTx, PLAN_AMOUNTS, termsHash } from "../../web/src/tx";

const FORK = process.argv[2]!;
const PORT = 18545;
const URL_ = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "../..");
const VAULT = "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2" as Address; // Steakhouse USDC (V1)
const PAID = "0x9b3d66c4ac6e282e45b51a07efea05eb90cf85b8" as Address; // real holder, about $519K
const FREE = "0xC30673F758E02069e28181edFD9D424c57f562af" as Address; // real holder, about $506
const PAY_TO = "0x00000000000000000000000000000000000caf0e" as Address;
const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const keeperKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const w1 = privateKeyToAccount(`0x${"a1".padStart(64, "0")}`);
const w2 = privateKeyToAccount(`0x${"b2".padStart(64, "0")}`);

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const anvil = spawn([join(ROOT, ".tools/foundry/v1.8.6/anvil"), "--fork-url", FORK, "--port", String(PORT), "--silent", "--no-rate-limit"], { stdout: "ignore", stderr: "ignore" });
try {
  const client = createPublicClient({ chain: base, transport: http(URL_), cacheTime: 0 });
  for (let i = 0; ; i++) {
    try { await client.getBlockNumber(); break; } catch { if (i > 120) throw new Error("anvil did not start"); await Bun.sleep(500); }
  }
  const rpc = (method: string, params: unknown[]) => client.request({ method, params } as never);
  const wallet = (account: Address | typeof deployer) => createWalletClient({ chain: base, transport: http(URL_), account });
  const artifact = (f: string) => JSON.parse(readFileSync(join(ROOT, "contracts/out", f), "utf8"));
  const send = async (from: Address, to: Address, data: Hex) => {
    await rpc("anvil_impersonateAccount", [from]);
    await rpc("anvil_setBalance", [from, "0x56BC75E2D63100000"]);
    const hash = await wallet(from).sendTransaction({ to, data, gas: 3_000_000n });
    const rcpt = await client.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`transaction reverted: to ${to}`);
    return rcpt;
  };
  const deploy = async (f: string, abi: never, args: unknown[]) => {
    const a = artifact(f);
    const hash = await wallet(deployer).deployContract({ abi, bytecode: a.bytecode.object, args: args as never });
    return (await client.waitForTransactionReceipt({ hash })).contractAddress as Address;
  };

  // Deploy, using the same bytecode the contract tests ran against.
  const startBlock = await client.getBlockNumber();
  const block = await client.getBlock();
  const nowChain = () => client.getBlock().then((b) => Number(b.timestamp));
  // v2: the watchers go in the AlarmBook's constructor, and the adapter (told where the router will be) in the router's.
  const book = await deploy("AlarmBook.sol/AlarmBook.json", alarmBookAbi as never, [deployer.address, [w1.address, w2.address]]);
  const nextNonce = await client.getTransactionCount({ address: deployer.address, blockTag: "pending" });
  const adapter = await deploy("ERC4626Adapter.sol/ERC4626Adapter.json", artifact("ERC4626Adapter.sol/ERC4626Adapter.json").abi as never, [getContractAddress({ from: deployer.address, nonce: BigInt(nextNonce + 1) })]);
  const router = await deploy("ExitRouter.sol/ExitRouter.json", routerAbi as never, [
    BASE.usdc, BASE.weth, BASE.swapRouter, book, deployer.address, deployer.address, BASE.usdcFeed, 90_000, block.timestamp + 31_536_000n, [adapter],
  ]);
  await rpc("anvil_setBalance", [keeperKey.address, "0x56BC75E2D63100000"]);
  check("contracts deployed on the Base fork", true, `router ${router.slice(0, 10)}`);

  // Storage and services.
  const pg = new PGlite();
  const db: Db = { query: async (s, p = []) => (await pg.query(s, p as never[])).rows as never, exec: async (s) => void (await pg.exec(s)) };
  await migrate(db);
  const r = repo(db);
  const keeperWallet = createWalletClient({ chain: base, transport: http(URL_), account: keeperKey });
  const k: KeeperDeps = {
    client: client as never, repo: r, router, alarmBook: book, multicall3: BASE.multicall3, morpho: BASE.morpho, account: keeperKey.address,
    send: async (tx) => {
      const hash = await keeperWallet.sendTransaction({ ...tx, gas: 3_000_000n });
      await client.waitForTransactionReceipt({ hash });
      return hash;
    },
    now: () => Math.floor(Date.now() / 1000) + 0,
    paidOnly: true,
  };
  const api = createApi({ db, repo: r, vaults: async () => [], liveAlarms: async () => [], watchers: [w1.address, w2.address], alarmBook: book, chainId: 8453, now: k.now });

  const sync = async (name: string) => {
    await syncLogs(client as never, r, { name: `router-${name}`, address: router, startBlock, step: 500n, onLog: (l) => applyRouterLog(r, l) });
  };

  // Risk card from the live vault.
  const card = await readCard(client as never, VAULT);
  check("risk card reads the live vault", card.assetSymbol === "USDC", cardText(card).split("\n")[1]);

  // Register an exploit alarm.
  const detector = { kind: 5, target: VAULT, threshold: 2n, window: 0, a: `0x${"00".repeat(32)}` as Hex, b: `0x${"00".repeat(32)}` as Hex };
  const reg = await wallet(deployer).writeContract({ address: book, abi: alarmBookAbi, functionName: "register", args: [detector] });
  await client.waitForTransactionReceipt({ hash: reg });
  const key = await client.readContract({ address: book, abi: alarmBookAbi, functionName: "keyOf", args: [detector] });
  await syncLogs(client as never, r, { name: "alarms1", address: book, startBlock, step: 500n, onLog: async (l) => void (await applyRegistered(db, l).catch(() => false)) });
  check("indexer stored the detector", (await db.query(`SELECT key FROM detectors`)).length === 1);

  // Real holders approve and arm, exactly as the web app builds it.
  const arm = async (who: Address) => {
    const approve = approveTx(VAULT, router);
    await send(who, approve.to, approve.data);
    const tx = armTx(router, adapter, VAULT, [key]);
    await send(who, tx.to, tx.data);
  };
  await arm(PAID);
  await arm(FREE);
  await sync("a");
  check("indexer stored both armed positions", (await r.armedWith(key)).length === 2);

  // A real $15 USDC payment from the paying wallet only.
  await send(BASE.morpho, BASE.usdc, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [PAID, 100_000_000n] }));
  const plan = planTx(BASE.usdc, PAY_TO, PLAN_AMOUNTS.months3);
  const payRcpt = await send(PAID, plan.to, plan.data);
  const payLog = payRcpt.logs.find((l) => l.address.toLowerCase() === BASE.usdc.toLowerCase());
  if (payLog) await applyPayment(r, payLog as never, k.now());
  check("plan payment credited to the paying wallet", (await r.paidUntil(PAID.toLowerCase())) !== null);

  // Watchers: an LLM label alone must not sign. Soft + confirmation must.
  const t = k.now();
  const feed: Signal = { kind: "FEED_EXPLOIT_CONFIRMED", target: VAULT, severity: "soft", value: 0.95, at: t, evidence: "sha" };
  const drain: Signal = { kind: "DRAIN", target: VAULT, severity: "soft", value: 2600, at: t, evidence: "peak" };
  check("an LLM label alone produces no signature", (await maybeAttest(w1, book, 8453, key, [feed], t)) === null);
  const chainNow = await nowChain();
  for (const w of [w1, w2]) {
    const a = (await maybeAttest(w, book, 8453, key, [drain, feed], chainNow))!;
    const res = await api.request("/watcher/attest", { method: "POST", body: JSON.stringify({ ...a, deadline: a.deadline.toString() }) });
    if (res.status !== 200) throw new Error(`attest ${res.status}`);
  }
  const a0 = (await maybeAttest(w1, book, 8453, key, [drain, feed], chainNow))!;
  const q = await quorumCall(db, a0, 2, book);
  check("two watchers reached quorum", q !== null);
  const fired = await send(keeperKey.address, q!.to, q!.data);
  const firedLog = fired.logs.map((l) => { try { return decodeFired(l as never); } catch { return null; } }).find(Boolean);
  check("the alarm fired on-chain", Boolean(firedLog));
  const live = await client.readContract({ address: book, abi: alarmBookAbi, functionName: "isLive", args: [key, 86_400n] });
  check("the alarm is live", live);

  // Keeper: paid wallet only.
  const queued = await onFired(k, key, t);
  check("Canopy's keeper queued the paid wallet only", queued === 1, `queued ${queued} of 2`);

  const bal = (who: Address) => client.readContract({ address: BASE.usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const shares = (who: Address) => client.readContract({ address: VAULT, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const [before, keeperBefore, freeShares] = await Promise.all([bal(PAID), bal(keeperKey.address), shares(FREE)]);
  await drainExits(k);
  const [after, keeperAfter, routerBal, paidShares, freeAfter] = await Promise.all([bal(PAID), bal(keeperKey.address), bal(router), shares(PAID), shares(FREE)]);
  check("the keeper exit paid the owner", after > before, `${((after - before) / 1_000_000n).toString()} USDC`);
  check("the owner has no shares left", paidShares === 0n);
  check("the keeper gained nothing", keeperAfter === keeperBefore);
  check("the router holds nothing", routerBal === 0n);
  check("the unpaid wallet was left alone by Canopy's keeper", freeAfter === freeShares);
  check("no exit job remains", (await r.dueJobs("exit", k.now() + 1)).length === 0);

  // Anyone else can still exit the unpaid wallet: nothing on-chain checks a plan.
  const posId = await client.readContract({ address: router, abi: routerAbi, functionName: "positionId", args: [FREE, adapter, VAULT, 0n] });
  const outsider = "0x000000000000000000000000000000000000dEaD" as Address;
  const freeBefore = await bal(FREE);
  await send(outsider, router, encodeFunctionData({ abi: routerAbi, functionName: "exit", args: [posId, key, 0n] }));
  check("an open keeper can still exit an unpaid wallet", (await bal(FREE)) > freeBefore && (await shares(FREE)) === 0n);

  // The owner's own buttons, using the web app's exact transactions.
  const OWNER = "0x3663774ab162264a7b3fdd1d3b977786cdab5dba" as Address; // real holder, about $351K
  await arm(OWNER);
  const ownerBefore = await bal(OWNER);
  const ownerPos = await client.readContract({ address: router, abi: routerAbi, functionName: "positionId", args: [OWNER, adapter, VAULT, 0n] });
  const armedEvents = await client.getContractEvents({ address: router, abi: routerAbi, eventName: "Armed", fromBlock: startBlock });
  check("the terms hash is recorded on-chain", armedEvents.every((e) => e.args.termsHash === termsHash()), `${armedEvents.length} arms`);
  const stop = disarmAllTx(router);
  await send(OWNER, stop.to, stop.data);
  check("Disarm All stops the position", !(await client.readContract({ address: router, abi: routerAbi, functionName: "isArmed", args: [ownerPos] })));
  await arm(OWNER);
  const leave = exitTx(router, ownerPos);
  await send(OWNER, leave.to, leave.data);
  check("Exit Now pays the owner with no alarm", (await bal(OWNER)) > ownerBefore && (await shares(OWNER)) === 0n);

} catch (e) {
  check("run finished", false, (e as Error).message.slice(0, 300));
} finally {
  anvil.kill();
}
const failed = results.filter((x) => !x[1]);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
