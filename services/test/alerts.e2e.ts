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
