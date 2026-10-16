/**
 * Free alerts with no Canopy contracts, as on Robinhood Chain. Real processes on real Postgres and a local chain, with a real drain and a real pause.
 * Telegram is a local stand-in. Start Postgres, then: bun test/alerts.e2e.ts [robinhood chain rpc url]
 * With an RPC URL it also reads the live Steakhouse USDG vault, to prove the same service works on the real chain.
 */
import { spawn } from "bun";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { ROBINHOOD } from "../src/chain/addresses";
import { postgres } from "../src/store/db";

const LIVE = process.argv[2];
const ROOT = join(import.meta.dir, "../..");
const BUN = join(ROOT, ".tools/bun/v1.4.4/bun");
const PORT = 18570, API = 18571, MOCK = 18572;
const RPC = `http://127.0.0.1:${PORT}`;
const PG = "postgres://canopy@127.0.0.1:15432";
const SECRET = "local-webhook-secret";
const CHAT = 777;
const work = mkdtempSync(join(tmpdir(), "canopy-alerts-"));
const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

const results: boolean[] = [];
const check = (n: string, ok: boolean, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const waitFor = async (what: string, fn: () => Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* still starting */ }
    await Bun.sleep(200);
  }
  console.log(`  timed out waiting for ${what}`);
  return false;
};

const telegram: { chat: number; text: string; buttons?: string }[] = [];
const mock = Bun.serve({
  port: MOCK,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: "Canopy", username: "canopy_bot" } });
    if (u.pathname.endsWith("/sendMessage")) {
      const b = (await req.json()) as { chat_id: number; text: string; reply_markup?: unknown };
      telegram.push({ chat: b.chat_id, text: b.text, buttons: JSON.stringify(b.reply_markup ?? "") });
      return Response.json({ ok: true, result: { message_id: telegram.length, date: 0, chat: { id: b.chat_id, type: "private" } } });
    }
    return new Response("nope", { status: 404 });
  },
});

const procs: ReturnType<typeof spawn>[] = [spawn([join(ROOT, ".tools/foundry/v1.8.6/anvil"), "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "ignore" })];

try {
  const client = createPublicClient({ chain: foundry, transport: http(RPC), cacheTime: 0 });
  await waitFor("anvil", async () => (await client.getBlockNumber()) >= 0n);
  const wallet = createWalletClient({ chain: foundry, transport: http(RPC), account: deployer });
  const artifact = (f: string) => JSON.parse(readFileSync(join(ROOT, "contracts/out/TestAssets.sol", f), "utf8"));
  const deploy = async (f: string, args: unknown[] = []) => {
    const a = artifact(f);
    return (await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: args as never }) })).contractAddress as Address;
  };
  const call = async (to: Address, data: Hex) => {
    const r = await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to, data }) });
    if (r.status !== "success") throw new Error(`reverted to ${to}`);
  };
  const abi = parseAbi([
    "function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function deposit(uint256,address) returns (uint256)",
    "function redeem(uint256,address,address) returns (uint256)", "function setPaused(bool)",
  ]);
  const data = (functionName: string, args: unknown[]) => encodeFunctionData({ abi, functionName, args } as never);

  const usd = await deploy("TestUSD.json");
  const vault = await deploy("TestVault.json", [usd]);
  const AMOUNT = 10_000_000_000n;
  await call(usd, data("mint", [deployer.address, AMOUNT]));
  await call(usd, data("approve", [vault, AMOUNT]));
  await call(vault, data("deposit", [AMOUNT, deployer.address]));

  const admin = postgres(`${PG}/postgres`);
  await admin.exec(`DROP DATABASE IF EXISTS canopy_alerts WITH (FORCE)`);
  await admin.exec(`CREATE DATABASE canopy_alerts`);
  const db = postgres(`${PG}/canopy_alerts`);

  const common = {
    ...(process.env as Record<string, string>), ALERTS_ONLY: "true", PUBLIC_URL: `http://127.0.0.1:${API}`, DATABASE_URL: `${PG}/canopy_alerts`, CHAIN_ID: String(ROBINHOOD.chainId),
    RPC_URL: RPC, RPC_URL_BACKUP: RPC, CARD_VAULTS: vault, TELEGRAM_BOT_TOKEN: "1:local", TELEGRAM_API_ROOT: `http://127.0.0.1:${MOCK}`, TELEGRAM_WEBHOOK_SECRET: SECRET, LOOP_SCALE: "0.05",
  };
  const launch = (name: string, env: Record<string, string>) => {
    const p = spawn([BUN, "src/index.ts"], { cwd: join(ROOT, "services"), env: { ...common, ...env }, stdout: Bun.file(join(work, `${name}.log`)), stderr: Bun.file(join(work, `${name}.err`)) });
    procs.push(p);
    return p;
  };
  launch("api", { ROLE: "api", PORT: String(API) });
  const started = await waitFor("api", async () => (await fetch(`http://127.0.0.1:${API}/vaults`)).ok);
  check("the service starts with no router or AlarmBook", started);

  const command = async (text: string, id: number) => {
    const length = text.indexOf(" ") < 0 ? text.length : text.indexOf(" ");
    const update = { update_id: id, message: { message_id: id, date: 0, chat: { id: CHAT, type: "private" }, from: { id: CHAT, is_bot: false, first_name: "U" }, text, entities: [{ type: "bot_command", offset: 0, length }] } };
    await fetch(`http://127.0.0.1:${API}/tg/webhook`, { method: "POST", body: JSON.stringify(update), headers: { "x-telegram-bot-api-secret-token": SECRET } });
  };
  await command(`/watch ${vault.toLowerCase()}`, 1);
  // A follower can name a vault that lives on another chain. It must do no harm here.
  await command("/watch 0x00000000000000000000000000000000000000c3", 2);
  check("a follower signed up with no wallet", await waitFor("follow", async () => (await db.query(`SELECT 1 FROM vault_follows`)).length === 2));

  launch("detector", { ROLE: "detector" });
  check("a risk card was built for the followed vault", await waitFor("card", async () => (await db.query(`SELECT 1 FROM risk_cards`)).length === 1));
  const alertsNow = () => telegram.filter((m) => m.text.startsWith("Heads up"));
  await waitFor("two snapshots", async () => (await db.query(`SELECT 1 FROM vault_snaps`)).length >= 2);
  check("a quiet vault sends no alert", alertsNow().length === 0);
  await command("/vaults", 3);
  check("/vaults lists the vault by name", await waitFor("vaults", async () => telegram.some((m) => m.text.includes("Canopy Test Vault:"))));

  await call(vault, data("redeem", [AMOUNT - AMOUNT / 5n, deployer.address, deployer.address]));
  check("a real drain reached the follower", await waitFor("drain alert", async () => alertsNow().some((m) => m.chat === CHAT && m.text.includes("about 80%"))));
  check("the alert names the vault", alertsNow()[0]?.text.includes("Canopy Test Vault") === true);
  check("the alert points to the Robinhood app", alertsNow()[0]?.text.includes("Robinhood app") === true);
  check("the alert has only a url button", alertsNow()[0]?.buttons?.includes('"url"') === true && !alertsNow()[0]?.buttons?.includes("web_app"));

  await Bun.sleep(9_000);
  check("the same drain doesn't alert twice", alertsNow().filter((m) => m.text.includes("about 80%")).length === 1, `${alertsNow().length} alerts`);

  await call(vault, data("setPaused", [true]));
  check("a real pause reached the follower", await waitFor("pause alert", async () => alertsNow().some((m) => m.text.includes("reports that it is paused"))));

  const errs = ["api", "detector"].flatMap((f) => readFileSync(join(work, `${f}.err`), "utf8").trim().split("\n").filter(Boolean));
  check("no loop errors were logged", errs.length === 0, errs.slice(0, 2).join(" | ").slice(0, 240));

  if (LIVE) {
    await admin.exec(`DROP DATABASE IF EXISTS canopy_rhc WITH (FORCE)`);
    await admin.exec(`CREATE DATABASE canopy_rhc`);
    const live = postgres(`${PG}/canopy_rhc`);
    launch("rhc", { ROLE: "detector", DATABASE_URL: `${PG}/canopy_rhc`, RPC_URL: LIVE, RPC_URL_BACKUP: LIVE, CARD_VAULTS: ROBINHOOD.steakhouseVault });
    check("the live Robinhood Chain vault got a risk card", await waitFor("live card", async () => (await live.query(`SELECT 1 FROM risk_cards`)).length === 1, 60_000));
    const card = (await live.query<{ text: string }>(`SELECT text FROM risk_cards`))[0]?.text ?? "";
    check("the card reads real numbers", card.includes("USDG") && !card.includes("about 0 "), card.split("\n").slice(0, 2).join(" / "));
    check("the live vault is being scanned", await waitFor("live snaps", async () => (await live.query(`SELECT 1 FROM vault_snaps`)).length >= 2, 60_000));
    const liveErrs = readFileSync(join(work, "rhc.err"), "utf8").trim();
    check("no errors on the live chain", liveErrs === "", liveErrs.slice(0, 240));
  }
} catch (e) {
  check("run finished", false, (e as Error).message.slice(0, 300));
} finally {
  for (const p of procs) p.kill();
  mock.stop(true);
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
