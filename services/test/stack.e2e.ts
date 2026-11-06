/**
 * The whole stack as real OS processes on real Postgres and a local fork of Robinhood Chain or Base.
 * Two independent operators, each with its own database and API. Telegram, Claude and the feed are local
 * stand-ins, because no live credentials are used. Start: bun test/stack.e2e.ts <rpc url>
 */
import { spawn } from "bun";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeErrorResult, encodeFunctionData, getContractAddress, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, robinhood } from "viem/chains";
import { alarmBookAbi, erc20Abi, routerAbi } from "../src/chain/abi";
import { BASE, ROBINHOOD } from "../src/chain/addresses";
import { postgres } from "../src/store/db";
import { approveTx, armTx, planTx, PLAN_AMOUNTS } from "../../web/src/tx";
import { COPY } from "../../web/src/copy/text";
import { revertText } from "../../web/src/errors";
import { attestDomain, attestTypes, signAttest } from "../src/watcher/attest";
import { presetsFor } from "../src/api/presets";

const FORK = process.argv[2]!;
// STACK_SPLIT=1 runs operator A the way production does: one process per role, keys only where needed, and a dead primary RPC.
const SPLIT = process.env.STACK_SPLIT === "1";
const ROOT = join(import.meta.dir, "../..");
const BUN = join(ROOT, ".tools/bun/v1.4.4/bun");
const RPC_PORT = 18546, API_A = 18443, API_B = 18444, MOCK = 18600;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const PG = "postgres://canopy@127.0.0.1:15432";
// Real vaults and real holders. Morpho Blue holds the stablecoin on both chains, so it funds the plan payments.
interface Profile { chain: Chain; stable: Address; weth: Address; swapRouter: Address; feed: Address; morpho: Address; symbol: string; explorer: string; vault: Address; hard: Address; quorum: Address }
const PROFILES: Record<string, Profile> = {
  robinhood: {
    chain: robinhood, stable: ROBINHOOD.usdg, weth: ROBINHOOD.weth, swapRouter: ROBINHOOD.swapRouter, feed: ROBINHOOD.usdgFeed, morpho: ROBINHOOD.morpho,
    symbol: "USDG", explorer: "robinhoodchain.blockscout.com/tx/", vault: ROBINHOOD.steakhouseVault as Address,
    hard: "0x32Ba0BD09218b1b93681ecF83304A1E5566421f1", quorum: "0xf705f15F34be971Abc30e2a4c7C9EB18793bb10e",
  },
  base: {
    chain: base, stable: BASE.usdc, weth: BASE.weth, swapRouter: BASE.swapRouter, feed: BASE.usdcFeed, morpho: BASE.morpho,
    symbol: "USDC", explorer: "basescan.org/tx/", vault: "0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2",
    hard: "0x9b3d66c4ac6e282e45b51a07efea05eb90cf85b8", quorum: "0x3663774ab162264a7b3fdd1d3b977786cdab5dba",
  },
};
const P = PROFILES[(await createPublicClient({ transport: http(FORK) }).getChainId()) === ROBINHOOD.chainId ? "robinhood" : "base"]!;
const VAULT = P.vault, HOLDER_HARD = P.hard, HOLDER_QUORUM = P.quorum;
const PAY_TO = "0x00000000000000000000000000000000000caf0e" as Address;
const SECRET = "local-webhook-secret";
const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const keeperKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const wA = `0x${"a1".padStart(64, "0")}` as Hex;
const wB = `0x${"b2".padStart(64, "0")}` as Hex;

const results: [string, boolean][] = [];
const check = (n: string, ok: boolean, d = "") => { results.push([n, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const waitFor = async (what: string, fn: () => Promise<boolean>, ms = 45_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* still starting */ }
    await Bun.sleep(250);
  }
  console.log(`  timed out waiting for ${what}`);
  return false;
};

// Local stand-ins.
const telegram: { chat: number; text: string }[] = [];
let feedText = "Routine status update. All systems normal.";
const mock = Bun.serve({
  port: MOCK,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/feed") return new Response(feedText);
    if (u.pathname === "/v1/messages") {
      const body = (await req.json()) as { messages: { content: string }[] };
      const exploit = body.messages[0]!.content.includes("drained");
      const verdict = exploit ? { label: "EXPLOIT_CONFIRMED", protocol: "Steakhouse", confidence: 0.97 } : { label: "IRRELEVANT", protocol: "none", confidence: 0.9 };
      return Response.json({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(verdict) }], usage: { input_tokens: 1, output_tokens: 1 } });
    }
    if (u.pathname.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: "Canopy", username: "canopy_bot" } });
    if (u.pathname.endsWith("/sendMessage")) {
      const b = (await req.json()) as { chat_id: number; text: string };
      telegram.push({ chat: b.chat_id, text: b.text });
      return Response.json({ ok: true, result: { message_id: telegram.length, date: 0, chat: { id: b.chat_id, type: "private" } } });
    }
    return new Response("nope", { status: 404 });
  },
});

const procs: ReturnType<typeof spawn>[] = [];
const anvil = spawn([join(ROOT, ".tools/foundry/v1.8.6/anvil"), "--fork-url", FORK, "--port", String(RPC_PORT), "--silent", "--no-rate-limit", "--block-time", "1"], { stdout: "ignore", stderr: "ignore" });
procs.push(anvil);

try {
  const client = createPublicClient({ chain: P.chain, transport: http(RPC), cacheTime: 0 });
  await waitFor("anvil", async () => (await client.getBlockNumber()) > 0n, 60_000);
  const rpc = (method: string, params: unknown[]) => client.request({ method, params } as never);
  const wallet = (a: Address | typeof deployer) => createWalletClient({ chain: P.chain, transport: http(RPC), account: a });
  const artifact = (f: string) => JSON.parse(readFileSync(join(ROOT, "contracts/out", f), "utf8"));
  const send = async (from: Address, to: Address, data: Hex) => {
    await rpc("anvil_impersonateAccount", [from]);
    await rpc("anvil_setBalance", [from, "0x56BC75E2D63100000"]);
    const r = await client.waitForTransactionReceipt({ hash: await wallet(from).sendTransaction({ to, data, gas: 3_000_000n }) });
    if (r.status !== "success") throw new Error(`reverted to ${to}`);
  };
  const deploy = async (f: string, args: unknown[] = []) => {
    const a = artifact(f);
    const hash = await wallet(deployer).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: args as never });
    return (await client.waitForTransactionReceipt({ hash })).contractAddress as Address;
  };
  const admin = async (tx: Promise<Hex>) => client.waitForTransactionReceipt({ hash: await tx });

  const start = await client.getBlockNumber(); // Logs start after this, so queries stay on the fork and off the public RPC.
  const block = await client.getBlock();
  // v2 needs no admin batch: the watchers are approved in the AlarmBook's constructor and the adapter is allowed in the router's.
  const watchers = [privateKeyToAccount(wA).address, privateKeyToAccount(wB).address];
  const book = await deploy("AlarmBook.sol/AlarmBook.json", [deployer.address, watchers]);
  const nextNonce = await client.getTransactionCount({ address: deployer.address, blockTag: "pending" });
  const predicted = getContractAddress({ from: deployer.address, nonce: BigInt(nextNonce + 1) });
  const adapter = await deploy("ERC4626Adapter.sol/ERC4626Adapter.json", [predicted]);
  const router = await deploy("ExitRouter.sol/ExitRouter.json", [P.stable, P.weth, P.swapRouter, book, deployer.address, deployer.address, P.feed, 90_000, block.timestamp + 31_536_000n, [adapter]]);
  if (router.toLowerCase() !== predicted.toLowerCase()) throw new Error("the router did not land where the adapter expected it");
  const pausable = await deploy("Mocks.sol/MockPausable.json");
  await rpc("anvil_setBalance", [privateKeyToAccount(keeperKey).address, "0x56BC75E2D63100000"]);

  // Fresh databases, one per operator.
  const admin_db = postgres(`${PG}/postgres`);
  for (const d of ["canopy_a", "canopy_b"]) {
    await admin_db.exec(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    await admin_db.exec(`CREATE DATABASE ${d}`);
  }
  const dbA = postgres(`${PG}/canopy_a`);
  const dbB = postgres(`${PG}/canopy_b`);

  const common = {
    ...process.env, PUBLIC_URL: "http://127.0.0.1:18443", CHAIN_ID: String(P.chain.id), RPC_URL: SPLIT ? "http://127.0.0.1:1" : RPC, RPC_URL_BACKUP: RPC, ROUTER: router, ALARM_BOOK: book, ADAPTER_4626: adapter,
    START_BLOCK: (start + 1n).toString(), PLAN_PAY_ADDRESS: PAY_TO, PLAN_TOKEN: P.stable, WATCHERS: watchers.join(","),
    CARD_VAULTS: VAULT, WATCHER_PEERS: `http://127.0.0.1:${API_A},http://127.0.0.1:${API_B}`, FEED_URLS: `http://127.0.0.1:${MOCK}/feed`,
    ANTHROPIC_API_KEY: "local", ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK}`, TELEGRAM_BOT_TOKEN: "1:local", TELEGRAM_API_ROOT: `http://127.0.0.1:${MOCK}`,
    TELEGRAM_WEBHOOK_SECRET: SECRET, LOOP_SCALE: process.env.STACK_SCALE ?? "0.05", ROLE: "all",
    // The fork mines a block a second, so a short confirmation depth still exercises the wait. Admin alerts go to the mock Telegram.
    CONFIRMATIONS: "2", OPS_CHAT_ID: "1",
  };
  const logDir = process.env.TMPDIR ?? "/tmp/";
  const ROLES = ["api", "indexer", "detector", "watcher", "keeper"] as const;
  const names = ["operator-a", "operator-a2", "operator-b", ...ROLES.map((x) => `operator-a-${x}`)];
  for (const n of names) for (const ext of ["log", "err"]) rmSync(`${logDir}${n}.${ext}`, { force: true });
  const launch = (name: string, env: Record<string, string>) => {
    const p = spawn([BUN, "src/index.ts"], { cwd: join(ROOT, "services"), env: { ...common, ...env }, stdout: Bun.file(`${process.env.TMPDIR ?? "/tmp/"}${name}.log`), stderr: Bun.file(`${process.env.TMPDIR ?? "/tmp/"}${name}.err`) });
    procs.push(p);
    return p;
  };
  const envA = { DATABASE_URL: `${PG}/canopy_a`, PORT: String(API_A) };
  const startA = (tag: string) => SPLIT
    ? ROLES.map((role) => launch(`${tag}-${role}`, { ...envA, ROLE: role, ...(role === "keeper" ? { KEEPER_PRIVATE_KEY: keeperKey } : {}), ...(role === "watcher" ? { WATCHER_PRIVATE_KEY: wA } : {}) }))
    : [launch(tag, { ...envA, KEEPER_PRIVATE_KEY: keeperKey, WATCHER_PRIVATE_KEY: wA })];
  const pA = startA("operator-a");
  const pB = launch("operator-b", { DATABASE_URL: `${PG}/canopy_b`, PORT: String(API_B), WATCHER_PRIVATE_KEY: wB });
  const ok = await waitFor("both APIs", async () => (await fetch(`http://127.0.0.1:${API_A}/alarms/live`)).ok && (await fetch(`http://127.0.0.1:${API_B}/alarms/live`)).ok);
  check("two operators started as separate processes on real Postgres", ok && pA.every((p) => p.exitCode === null) && pB.exitCode === null);

  // The constructors emit the admin events (one AdapterSet, a WatcherSet per watcher). Each operator reads them from the deploy block and tells the ops chat.
  check("the ops chat heard both watchers and the adapter from the constructors", await waitFor("ops events", async () =>
    telegram.filter((m) => m.chat === 1 && m.text.includes("admin event WatcherSet")).length >= 2 && telegram.some((m) => m.chat === 1 && m.text.includes("admin event AdapterSet"))));

  // A real Telegram update reaches the bot through the webhook.
  const watchUpdate = { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 777, type: "private" }, from: { id: 777, is_bot: false, first_name: "U" }, text: `/watch ${VAULT.toLowerCase()}`, entities: [{ type: "bot_command", offset: 0, length: 6 }] } };
  const hook = (secret?: string) => fetch(`http://127.0.0.1:${API_A}/tg/webhook`, { method: "POST", body: JSON.stringify(watchUpdate), headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {} });
  check("the webhook refuses a missing secret", (await hook()).status === 403);
  await hook(SECRET);
  check("the bot followed the vault and replied", await waitFor("bot", async () => telegram.some((m) => m.text.includes("Following")) && (await dbA.query(`SELECT 1 FROM vault_follows`)).length === 1));

  // Register alarms and arm real holders, using the web app's own transactions.
  const hard = { kind: 2, target: pausable, threshold: 0n, window: 0, a: `0x${"00".repeat(32)}` as Hex, b: `0x${"00".repeat(32)}` as Hex };
  const quorum = presetsFor(VAULT)[1]!.detector;
  for (const d of [hard, quorum]) await admin(wallet(deployer).writeContract({ address: book, abi: alarmBookAbi, functionName: "register", args: [d] }));
  const hardKey = await client.readContract({ address: book, abi: alarmBookAbi, functionName: "keyOf", args: [hard] });
  const quorumKey = await client.readContract({ address: book, abi: alarmBookAbi, functionName: "keyOf", args: [quorum] });
  for (const [who, key] of [[HOLDER_HARD, hardKey], [HOLDER_QUORUM, quorumKey]] as const) {
    const a = approveTx(VAULT, router);
    await send(who, a.to, a.data);
    const t = armTx(router, adapter, VAULT, [key]);
    await send(who, t.to, t.data);
    await send(P.morpho, P.stable, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [who, 100_000_000n] }));
    const p = planTx(P.stable, PAY_TO, PLAN_AMOUNTS.months3);
    await send(who, p.to, p.data);
  }
  check("the indexer picked up both positions", await waitFor("positions", async () => (await dbA.query(`SELECT 1 FROM positions WHERE active`)).length === 2));
  check("the indexer credited both plan payments", await waitFor("plans", async () => (await dbA.query(`SELECT 1 FROM plans`)).length === 2));
  check("both operators stored the detectors", await waitFor("detectors", async () => (await dbB.query(`SELECT 1 FROM detectors`)).length === 2));
  check("the risk card was built and served by the API", await waitFor("card", async () => {
    const r = await fetch(`http://127.0.0.1:${API_A}/risk/${VAULT}`);
    return r.ok && ((await r.json()) as { text: string }).text.includes(P.symbol);
  }));
  check("the API lists the vault by name", await waitFor("vaults", async () => {
    const list = (await (await fetch(`http://127.0.0.1:${API_A}/vaults`)).json()) as { name: string | null; asset: string | null }[];
    return list.length === 1 && Boolean(list[0]!.name) && list[0]!.asset === P.symbol;
  }));

  const shares = (w: Address) => client.readContract({ address: VAULT, abi: erc20Abi, functionName: "balanceOf", args: [w] });
  const bal = (w: Address) => client.readContract({ address: P.stable, abi: erc20Abi, functionName: "balanceOf", args: [w] });

  // Path 1: a hard on-chain alarm. Nobody touches the services after the pause.
  const b1 = await bal(HOLDER_HARD);
  await send(deployer.address, pausable, encodeFunctionData({ abi: artifact("Mocks.sol/MockPausable.json").abi, functionName: "setPaused", args: [true] }));
  const t0 = Date.now();
  const exited = await waitFor("hard exit", async () => (await shares(HOLDER_HARD)) === 0n);
  check("a hard alarm ran the whole path unattended", exited, `${((Date.now() - t0) / 1000).toFixed(1)}s from pause to exit, loops at ${common.LOOP_SCALE}x`);
  check("the owner was paid", (await bal(HOLDER_HARD)) > b1, `${((await bal(HOLDER_HARD)) - b1) / 1_000_000n} ${P.symbol}`);
  check("the exit job finished", await waitFor("job", async () => (await dbA.query(`SELECT 1 FROM jobs WHERE kind='exit' AND done`)).length === 1));
  await Bun.sleep(1000);
  check("a key that isn't one of the vault's presets alerts nobody", !telegram.some((m) => m.text.includes("Alarm on")));
  check("the API shows the live alarm", await waitFor("live", async () => ((await (await fetch(`http://127.0.0.1:${API_A}/alarms/live`)).json()) as unknown[]).length === 1));

  // A key that is going off cannot be armed on a new position: one that fired in the last day, and one tripped now that nobody poked.
  const armFrom = async (from: Address, key: Hex) => {
    const t = armTx(router, adapter, VAULT, [key]);
    try {
      await client.call({ account: from, to: t.to, data: t.data });
      return null;
    } catch (e) {
      const data = [(e as { data?: Hex }).data, (e as { cause?: { data?: Hex } }).cause?.data, (e as { cause?: { cause?: { data?: Hex } } }).cause?.cause?.data].find((x) => typeof x === "string" && x.startsWith("0x"));
      return { error: data ? decodeErrorResult({ abi: routerAbi, data }) : null, text: revertText(e) };
    }
  };
  const refused1 = await armFrom(HOLDER_HARD, hardKey);
  check("arm refuses a key that fired in the last day (AlarmNotClear)", refused1?.error?.errorName === "AlarmNotClear" && (refused1.error.args as readonly Hex[])[0] === hardKey);
  check("the web app says so in plain words", refused1?.text === COPY.errAlarmNotClear);
  const pausable2 = await deploy("Mocks.sol/MockPausable.json");
  const hard2 = { ...hard, target: pausable2 };
  await admin(wallet(deployer).writeContract({ address: book, abi: alarmBookAbi, functionName: "register", args: [hard2] }));
  const hard2Key = await client.readContract({ address: book, abi: alarmBookAbi, functionName: "keyOf", args: [hard2] });
  check("a fresh key reads armable", await client.readContract({ address: book, abi: alarmBookAbi, functionName: "armable", args: [hard2Key] }));
  await send(deployer.address, pausable2, encodeFunctionData({ abi: artifact("Mocks.sol/MockPausable.json").abi, functionName: "setPaused", args: [true] }));
  const refused2 = await armFrom(HOLDER_HARD, hard2Key);
  check("arm refuses a key that reads tripped right now, though it never fired", refused2?.error?.errorName === "AlarmNotClear" && (refused2.error.args as readonly Hex[])[0] === hard2Key);
  check("armable is false for both, true for a clear key", !(await client.readContract({ address: book, abi: alarmBookAbi, functionName: "armable", args: [hardKey] }))
    && !(await client.readContract({ address: book, abi: alarmBookAbi, functionName: "armable", args: [hard2Key] }))
    && await client.readContract({ address: book, abi: alarmBookAbi, functionName: "armable", args: [quorumKey] }));

  // Path 2: a hack report. It arrives first, and the report alone must do nothing.
  const b2 = await bal(HOLDER_QUORUM);
  await Bun.sleep(1000);
  check("a routine report fired nothing", (await dbA.query(`SELECT 1 FROM attestations`)).length === 0);
  feedText = "Security alert: Steakhouse vault drained by an attacker.";
  check("both operators labelled the report", await waitFor("labels", async () =>
    (await dbA.query(`SELECT 1 FROM feed_items WHERE label='EXPLOIT_CONFIRMED'`)).length === 1 && (await dbB.query(`SELECT 1 FROM feed_items WHERE label='EXPLOIT_CONFIRMED'`)).length === 1));
  await Bun.sleep(1500);
  check("a report alone signed nothing", (await dbA.query(`SELECT 1 FROM attestations`)).length === 0 && (await shares(HOLDER_QUORUM)) > 0n);

  // The on-chain soft signal arrives later. It is injected, because a real drain can't be staged here.
  const now = Math.floor(Date.now() / 1000);
  for (const db of [dbA, dbB]) {
    await db.query(`INSERT INTO signals (kind, target, severity, value, evidence, at) VALUES ('DRAIN',$1,'soft',2600,$2,$3)`, [VAULT.toLowerCase(), `snapshot-${db === dbA ? "a" : "b"}`, now]);
  }
  const t1 = Date.now();
  check("both watchers signed through real HTTP gossip", await waitFor("signatures", async () => (await dbA.query(`SELECT DISTINCT signer FROM attestations`)).length === 2));
  const exit2 = await waitFor("quorum exit", async () => (await shares(HOLDER_QUORUM)) === 0n);
  check("the quorum fired and the keeper exited", exit2, `${((Date.now() - t1) / 1000).toFixed(1)}s from report to exit`);
  check("that owner was paid", (await bal(HOLDER_QUORUM)) > b2, `${((await bal(HOLDER_QUORUM)) - b2) / 1_000_000n} ${P.symbol}`);
  check("followers got a Telegram alert for the preset", await waitFor("alert", async () => telegram.some((m) => m.chat === 777 && m.text.includes("Alarm on") && m.text.includes(P.explorer))));
  check("the router holds nothing", (await bal(router)) === 0n);
  const open = await dbA.query<{ dedupe: string; attempts: number }>(`SELECT dedupe, attempts FROM jobs WHERE NOT done`);
  console.log(`  jobs still open when the exit landed: ${open.length}, attempts ${open.map((j) => j.attempts).join(",")}`);
  check("no job is left waiting", await waitFor("jobs", async () => (await dbA.query(`SELECT 1 FROM jobs WHERE NOT done`)).length === 0, 5_000));

  // Path 3: a DRAIN alarm fires in two steps. The first poke that sees the drop only records it (Pending), and a poke a minute
  // later fires it. The keeper must count the first as progress, not as a miss, and come back for the second.
  const token = await deploy("Mocks.sol/MockERC20.json", [6]);
  const mockVault = await deploy("Mocks.sol/MockVault.json", [token, 10n ** 18n]);
  const mocks = artifact("Mocks.sol/MockVault.json").abi;
  const SINK = "0x00000000000000000000000000000000000051c0" as Address;
  await send(deployer.address, mockVault, encodeFunctionData({ abi: mocks, functionName: "mint", args: [SINK, 1_000n * 10n ** 18n] }));
  const drain = { kind: 4, target: mockVault, threshold: 2500n, window: 1200, a: `0x${"00".repeat(32)}` as Hex, b: `0x${"00".repeat(32)}` as Hex };
  await admin(wallet(deployer).writeContract({ address: book, abi: alarmBookAbi, functionName: "register", args: [drain] }));
  const drainKey = await client.readContract({ address: book, abi: alarmBookAbi, functionName: "keyOf", args: [drain] });
  // A DRAIN can only be armed paired with a watcher quorum over one day (DrainNeedsQuorum), as the app's preset does. The
  // keeper polls the parts of an armed BOTH key, so the DRAIN part is still poked and confirmed on its own.
  const zero = `0x${"00".repeat(32)}` as Hex;
  // The quorum part is the vault preset's watcher quorum registered above.
  const both = { kind: 6, target: mockVault, threshold: 0n, window: 86_400, a: drainKey, b: quorumKey };
  await admin(wallet(deployer).writeContract({ address: book, abi: alarmBookAbi, functionName: "register", args: [both] }));
  const bothKey = await client.readContract({ address: book, abi: alarmBookAbi, functionName: "keyOf", args: [both] });
  // A paying owner with no shares arms a position on the real vault with this key, so the keeper polls it and its exit job ends at once.
  await send(P.morpho, P.stable, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [deployer.address, 100_000_000n] }));
  const dp = planTx(P.stable, PAY_TO, PLAN_AMOUNTS.months3);
  await send(deployer.address, dp.to, dp.data);
  const da = armTx(router, adapter, VAULT, [bothKey]);
  await send(deployer.address, da.to, da.data);
  check("the DRAIN position and its plan reached the keeper's database", await waitFor("drain position", async () =>
    (await dbA.query(`SELECT 1 FROM positions WHERE active`)).length === 3 && (await dbA.query(`SELECT 1 FROM plans`)).length === 3));
  // The reference is live after two rolls of one sampling period (600 s) each, so the fork's clock moves twice, with a
  // checkpoint after each.
  for (let i = 0; i < 2; i++) {
    await rpc("evm_increaseTime", [610]);
    await rpc("evm_mine", []);
    await send(deployer.address, book, encodeFunctionData({ abi: alarmBookAbi, functionName: "checkpoint", args: [drainKey] }));
  }
  const drainState = () => client.readContract({ address: book, abi: alarmBookAbi, functionName: "state", args: [drainKey] });
  const counter = async (name: string) => Number((await dbA.query<{ value: string }>(`SELECT value FROM counters WHERE name=$1`, [name]))[0]?.value ?? 0);
  check("the reference rolled and nothing is pending", (await drainState())[4] === 1_000n * 10n ** 18n && (await drainState())[6] === 0n);
  const misses0 = await counter("poke_miss"), fails0 = await counter("poke_fail"), pending0 = await counter("poke_pending");
  await send(deployer.address, mockVault, encodeFunctionData({ abi: mocks, functionName: "setPrice", args: [5n * 10n ** 17n] })); // half the assets are gone
  const tDrain = Date.now();
  check("the keeper's first poke recorded the drop (Pending) and did not fire", await waitFor("pending", async () => (await drainState())[6] > 0n, 30_000)
    && !(await client.readContract({ address: book, abi: alarmBookAbi, functionName: "isLive", args: [drainKey, 86_400n] })));
  check("that poke counted as progress, not a miss or a failure", await waitFor("pending counter", async () => (await counter("poke_pending")) > pending0, 10_000)
    && (await counter("poke_miss")) === misses0 && (await counter("poke_fail")) === fails0);
  check("the keeper came back a minute later and the second poke fired it", await waitFor("drain fired", async () =>
    await client.readContract({ address: book, abi: alarmBookAbi, functionName: "isLive", args: [drainKey, 86_400n] }), 120_000),
  `${((Date.now() - tDrain) / 1000).toFixed(0)}s after the drop`);
  check("the indexer recorded the DRAIN alarm", await waitFor("drain alarm", async () => (await dbA.query(`SELECT 1 FROM alarms WHERE key=$1`, [drainKey])).length === 1, 20_000));
  check("the DRAIN exit job ended with nothing to exit", await waitFor("drain job", async () => (await dbA.query(`SELECT 1 FROM jobs WHERE NOT done`)).length === 0, 20_000));
  check("a pending sighting cleared once it fired", (await drainState())[6] === 0n);

  // Watchers sign under AlarmBook v2's domain. A version 1 signature is refused on chain.
  const quorum2 = { kind: 5, target: pausable, threshold: 2n, window: 0, a: `0x${"00".repeat(32)}` as Hex, b: `0x${"00".repeat(32)}` as Hex };
  await admin(wallet(deployer).writeContract({ address: book, abi: alarmBookAbi, functionName: "register", args: [quorum2] }));
  const q2 = await client.readContract({ address: book, abi: alarmBookAbi, functionName: "keyOf", args: [quorum2] });
  const evidence = `0x${"7e".repeat(32)}` as Hex;
  const deadline = (await client.getBlock()).timestamp + 900n;
  const sorted = [wA, wB].map((k) => privateKeyToAccount(k)).sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));
  const sigs = {
    v2: await Promise.all(sorted.map((a) => signAttest(a, book, P.chain.id, q2, evidence, deadline))),
    v1: await Promise.all(sorted.map((a) => a.signTypedData({ domain: { ...attestDomain(book, P.chain.id), version: "1" }, types: attestTypes, primaryType: "Attest", message: { key: q2, evidence, deadline } }))),
  };
  const fire = (v: "v1" | "v2") => client.simulateContract({ address: book, abi: alarmBookAbi, functionName: "fireByQuorum", args: [q2, evidence, deadline, sorted.map((a) => a.address), sigs[v]], account: deployer.address });
  check("the AlarmBook's domain version is 2", (await client.readContract({ address: book, abi: alarmBookAbi, functionName: "DOMAIN_SEPARATOR" })) === (await import("../deploy/verify")).domainSeparator(P.chain.id, book));
  check("signatures made under version 1 are refused (BadSignature)", await fire("v1").then(() => false, (e: Error) => /BadSignature/.test(e.message)));
  check("signatures made under version 2 are accepted", await fire("v2").then(() => true, () => false));
  await admin(wallet(deployer).writeContract({ address: book, abi: alarmBookAbi, functionName: "fireByQuorum", args: [q2, evidence, deadline, sorted.map((a) => a.address), sigs.v2] }));
  check("the quorum alarm fired from version 2 signatures", await client.readContract({ address: book, abi: alarmBookAbi, functionName: "isLive", args: [q2, 60n] }));

  // Restart: the indexer resumes from its cursor and credits nothing twice.
  const paid = await dbA.query<{ paid_until: string }>(`SELECT paid_until FROM plans ORDER BY wallet`);
  for (const p of pA) p.kill();
  await Promise.all(pA.map((p) => p.exited));
  const pA2 = startA("operator-a2");
  await waitFor("restart", async () => (await fetch(`http://127.0.0.1:${API_A}/alarms/live`)).ok);
  await Bun.sleep(1500);
  const paid2 = await dbA.query<{ paid_until: string }>(`SELECT paid_until FROM plans ORDER BY wallet`);
  check("a restart credited nothing twice", JSON.stringify(paid) === JSON.stringify(paid2) && pA2.every((p) => p.exitCode === null));
  const errFiles = SPLIT ? ROLES.map((x) => `operator-a-${x}`) : ["operator-a"];
  const errs = errFiles.flatMap((f) => readFileSync(`${logDir}${f}.err`, "utf8").trim().split("\n").filter(Boolean));
  check("no loop errors were logged", errs.length === 0, errs.slice(0, 3).join(" | ").slice(0, 220));
} catch (e) {
  check("run finished", false);
  console.log((e as Error).message.slice(0, 400));
} finally {
  for (const p of procs) p.kill();
  mock.stop(true);
}
const failed = results.filter((x) => !x[1]);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
