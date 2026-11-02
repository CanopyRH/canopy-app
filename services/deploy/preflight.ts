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
