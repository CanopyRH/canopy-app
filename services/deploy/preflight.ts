/**
 * Read-only check that everything is in place before the mainnet deploy. Sends nothing and prints no secret values.
 * Reminders cover choices that belong to the team. They are printed but never count as failures.
 * Usage: bun deploy/preflight.ts <rpc url> [services env file]
 * Launch chains are Robinhood Chain (4663) and Base (8453). deploy/settings.json picks one.
 */
import { spawnSync } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem";
import { CONFIG } from "../../web/src/config";
import type { Settings } from "./plan";
import type { Check } from "./verify";

const ROOT = join(import.meta.dir, "../..");
const DAY = 86_400;
const MIN_ADMIN_LIFE = 180 * DAY;
const MAX_ADMIN_LIFE = 730 * DAY;
const MAX_HEARTBEAT = 2 * DAY;
const MIN_DEPLOYER_WEI = 1_000_000_000_000_000n; // 0.001 ETH
const MIN_KEEPER_WEI = 500_000_000_000_000n; // the keeper's own low-gas warning
const MAX_DELAY = 30 * DAY;
export const LAUNCH_CHAINS: Record<number, string> = { 4663: "Robinhood Chain", 8453: "Base" };
// Keyless endpoints. A keyed URL from the same provider, such as lb.drpc.live, is private.
const PUBLIC_RPCS = [
  "mainnet.base.org", "publicnode.com", "llamarpc.com", "1rpc.io", "base.drpc.org", "blastapi.io",
  "rpc.mainnet.chain.robinhood.com", "robinhood.drpc.org", "robinhood-mainnet.drpc.org", "rpc.safe.global",
];
const SERVICE_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "HEALTH_TOKEN", "OPS_CHAT_ID", "ANTHROPIC_API_KEY", "FEED_URLS"];

const safeAbi = parseAbi(["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"]);
const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const assetAbi = parseAbi(["function asset() view returns (address)", "function totalAssets() view returns (uint256)"]);

export type LaunchSettings = Partial<Settings> & { auditReport?: string; auditedCommit?: string; termsApproved?: boolean; keeper?: Address; deployer?: Address };
export type PreflightCheck = Check & { reminder?: boolean };
export interface Launch {
  settings: LaunchSettings;
  /** deploy/launch.env, which the deploy command reads. */
  deployEnv: Record<string, string>;
  webChainId: number;
  services: Record<string, string> | null;
  webVaults: Address[];
  testConfigInWeb: boolean;
  /** True when contracts/src is unchanged since the audited commit. */
  contractsMatchAudit: (commit: string) => boolean;
}

const isAddress = (a: unknown): a is Address => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const same = (a?: string, b?: string) => a?.toLowerCase() === b?.toLowerCase();
const host = (url = "") => URL.canParse(url) ? new URL(url).hostname : "";

export async function preflight(client: PublicClient, l: Launch, now: number): Promise<PreflightCheck[]> {
  const out: PreflightCheck[] = [];
  const check = (name: string, ok: boolean, detail?: string) => out.push({ name, ok, detail: ok ? undefined : detail });
  const remind = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail: ok ? undefined : detail, reminder: true });
  const s = l.settings;
  const hasCode = async (a: Address) => ((await client.getCode({ address: a })) ?? "0x").length > 2;
  const read = <T>(address: Address, abi: unknown, functionName: string) =>
    client.readContract({ address, abi, functionName } as never) as Promise<T>;

  remind("External audit report is linked", /^https:\/\//.test(s.auditReport ?? ""), "recommended; set auditReport in deploy/settings.json");
  remind("A lawyer approved the terms", s.termsApproved === true, "recommended; set termsApproved in deploy/settings.json");
  remind("Contracts are unchanged since the audited commit", Boolean(s.auditedCommit) && l.contractsMatchAudit(s.auditedCommit!), "recommended; set auditedCommit in deploy/settings.json");

  check("Settings target a launch chain", Boolean(LAUNCH_CHAINS[s.chainId ?? 0]), `chainId is ${s.chainId}`);
  check("Web app targets the same chain", l.webChainId === s.chainId, `web app is on ${l.webChainId}`);
  check("No test Timelock", s.testTimelockDelay === undefined, "remove testTimelockDelay");
  check("No plain-wallet admins", !s.allowEoaAdmin, "remove allowEoaAdmin");
  const delay = s.timelockDelay ?? 0;
  check("Timelock delay is 0 to 30 days", Number.isInteger(delay) && delay >= 0 && delay <= MAX_DELAY, `timelockDelay is ${delay}`);
  const expiry = s.adminExpiry ?? 0;
  check("Admin expiry is 180 to 730 days away", expiry >= now + MIN_ADMIN_LIFE && expiry <= now + MAX_ADMIN_LIFE, "set adminExpiry, about 12 months from the deploy");
  check("Feed heartbeat is valid", (s.heartbeat ?? 0) > 0 && (s.heartbeat ?? 0) <= MAX_HEARTBEAT, `heartbeat is ${s.heartbeat}`);
  for (const [key, want] of [
    ["STABLE", s.stable], ["WETH", s.weth], ["SWAP_ROUTER", s.swapRouter], ["STABLE_FEED", s.stableFeed],
    ["PROPOSER_MULTISIG", s.proposer], ["GUARDIAN_MULTISIG", s.guardian],
    ["STABLE_FEED_HEARTBEAT", String(s.heartbeat)], ["ADMIN_EXPIRY", String(s.adminExpiry)], ["TIMELOCK_DELAY", String(delay)],
  ] as const) {
    check(`launch.env and settings.json agree on ${key}`, Boolean(l.deployEnv[key]) && same(l.deployEnv[key], want), "they differ, or one is empty");
  }

  check("Proposer and guardian are different Safes", isAddress(s.proposer) && isAddress(s.guardian) && !same(s.proposer, s.guardian), "two separate Safes are needed");
  for (const [name, safe] of [["Proposer", s.proposer], ["Guardian", s.guardian]] as const) {
    if (!isAddress(safe)) { check(`${name} Safe needs 2 or more signers`, false, "address not set"); continue; }
    const threshold = await read<bigint>(safe, safeAbi, "getThreshold").catch(() => 0n);
    check(`${name} Safe needs 2 or more signers`, threshold >= 2n, threshold === 0n ? "not a Safe" : `threshold is ${threshold}`);
  }

  const watchers = (s.watchers ?? []).filter(isAddress).map((w) => w.toLowerCase());
  check("Three different watchers", new Set(watchers).size === 3, `${new Set(watchers).size} valid`);
  check("Keeper is separate from the watchers", isAddress(s.keeper) && !watchers.includes(s.keeper.toLowerCase()), "set keeper in deploy/settings.json");
  if (isAddress(s.keeper)) check("Keeper holds gas", (await client.getBalance({ address: s.keeper })) >= MIN_KEEPER_WEI, "needs at least 0.0005 ETH");
  check("Deployer is set", isAddress(s.deployer), "set deployer in deploy/settings.json");
  if (isAddress(s.deployer)) check("Deployer holds gas", (await client.getBalance({ address: s.deployer })) >= MIN_DEPLOYER_WEI, "needs at least 0.001 ETH");

  for (const [name, a] of [["Stablecoin", s.stable], ["WETH", s.weth], ["Swap router", s.swapRouter], ["Feed", s.stableFeed]] as const) {
    check(`${name} contract exists`, isAddress(a) && await hasCode(a), "no contract at that address");
  }
  if (isAddress(s.stableFeed)) {
    const decimals = await read<number>(s.stableFeed, feedAbi, "decimals").catch(() => 0);
    const [, answer, , updatedAt] = await read<[bigint, bigint, bigint, bigint, bigint]>(s.stableFeed, feedAbi, "latestRoundData").catch(() => [0n, 0n, 0n, 0n, 0n] as const);
    check("Feed reads about $1", decimals === 8 && answer >= 90_000_000n && answer <= 110_000_000n, `answer ${answer}, ${decimals} decimals`);
    check("Feed is fresh", now - Number(updatedAt) <= (s.heartbeat ?? 0), `updated ${now - Number(updatedAt)}s ago`);
  }

  const vaults = (s.vaults ?? []).filter(isAddress);
  const missing = l.webVaults.filter((v) => !vaults.some((x) => same(x, v)));
  const extra = vaults.filter((v) => !l.webVaults.some((x) => same(x, v)));
  check("settings.json lists exactly the web app's vaults", vaults.length > 0 && missing.length + extra.length === 0, `${missing.length} missing, ${extra.length} extra`);
  for (const v of vaults) {
    const asset = await read<Address>(v, assetAbi, "asset").catch(() => null);
    const total = await read<bigint>(v, assetAbi, "totalAssets").catch(() => 0n);
    check(`Vault ${v.slice(0, 8)} holds the stablecoin`, same(asset ?? undefined, s.stable) && total > 0n, asset ? `asset ${asset}, ${total} assets` : "asset() failed");
  }

  check("Web app has no test deployment", !l.testConfigInWeb, "set web/src/deployment.json to {}");

  const e = l.services;
  check("Service settings file was given", e !== null, "pass the file as the second argument");
  if (e) {
    const blank = SERVICE_KEYS.filter((k) => !e[k]);
    check("Service secrets are set", blank.length === 0, `blank: ${blank.join(", ")}`);
    check("Services run on the same chain", e.CHAIN_ID === String(s.chainId), `CHAIN_ID is ${e.CHAIN_ID}`);
    if (e.PLAN_TOKEN) check("Plan payments use the launch stablecoin", same(e.PLAN_TOKEN, s.stable), "PLAN_TOKEN differs from stable");
    check("No placeholder values remain", !Object.values(e).some((v) => /CHANGE_ME|example\.com|YOUR_/.test(v)), "replace the example values");
    check("Public URL uses HTTPS", /^https:\/\//.test(e.PUBLIC_URL ?? ""), "PUBLIC_URL must be https");
    check("Database requires TLS", /sslmode=(require|verify-full)/.test(e.DATABASE_URL ?? ""), "add sslmode=require");
    check("RPC is a private endpoint", Boolean(e.RPC_URL) && !PUBLIC_RPCS.some((h) => host(e.RPC_URL).endsWith(h)), "public RPCs rate-limit, so the keeper could miss an exit");
    check("Backup RPC is a different provider", Boolean(e.RPC_URL_BACKUP) && host(e.RPC_URL) !== host(e.RPC_URL_BACKUP), "use a second provider");
    const cards = (e.CARD_VAULTS ?? "").split(",").map((v) => v.toLowerCase());
    check("CARD_VAULTS covers every web vault", l.webVaults.every((v) => cards.includes(v.toLowerCase())), "copy the list from deploy/services.env.example");
    const pay = e.PLAN_PAY_ADDRESS;
    check("Plan payments go to a multisig", isAddress(pay) && await hasCode(pay), "set PLAN_PAY_ADDRESS to a Safe");
  }
  return out;
}
