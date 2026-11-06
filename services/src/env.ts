import { z } from "zod";

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const Env = z.object({
  ROLE: z.enum(["all", "api", "bot", "indexer", "detector", "watcher", "keeper"]).default("all"),
  PORT: z.coerce.number().default(8443), // Telegram webhooks: 443/80/88/8443 only, TLS 1.2+, IPv4
  PUBLIC_URL: z.url(), // this service's own address, for the Telegram webhook
  APP_URL: z.url().optional(), // the web app that bot buttons open; off means PUBLIC_URL
  DATABASE_URL: z.string(),
  DB_POOL: z.coerce.number().int().min(1).max(50).default(4), // connections per process; 7 services × 4, doubled during a deploy, stays under 100
  CHAIN_ID: z.coerce.number(),
  RPC_URL: z.url(),
  RPC_URL_BACKUP: z.url(),
  ALERTS_ONLY: z.stringbool().default(false), // free alerts on a chain with no Canopy contracts, such as Robinhood Chain
  ROUTER: addr.optional(),
  ALARM_BOOK: addr.optional(),
  ADAPTER_4626: addr.optional(),
  START_BLOCK: z.coerce.bigint().default(0n),
  PLAN_PAY_ADDRESS: addr.optional(), // receives prepaid plan payments; a multisig
  PLAN_TOKEN: addr.optional(),
  KEEPER_PRIVATE_KEY: z.string().optional(), // pays gas only; holds no user funds
  KEEPER_PAID_ONLY: z.stringbool().default(true),
  QUORUM: z.coerce.number().default(2),
  WATCHER_PRIVATE_KEY: z.string().optional(),
  WATCHERS: z.string().default(""), // comma-separated approved watcher addresses
  WATCHER_PEERS: z.string().default(""), // comma-separated peer API URLs for attestation gossip
  FEED_URLS: z.string().default(""), // comma-separated allowlisted public sources
  CARD_VAULTS: z.string().default(""), // comma-separated vaults that always get a risk card
  ANTHROPIC_API_KEY: z.string().optional(), // classification only
  ANTHROPIC_BASE_URL: z.url().optional(), // a compatible service such as PPQ; off means Anthropic directly
  CLASSIFIER_MODEL: z.string().min(1).optional(), // that service's model name
  TELEGRAM_BOT_TOKEN: z.string(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
  BOT_MODE: z.enum(["webhook", "polling"]).default("webhook"),
  TELEGRAM_API_ROOT: z.url().optional(), // local test server only
  LOOP_SCALE: z.coerce.number().positive().default(1), // shortens loop intervals in local runs
  OPS_CHAT_ID: z.coerce.number().optional(), // Telegram chat for operator warnings
  HEALTH_TOKEN: z.string().min(16).optional(), // bearer token for GET /health; off without one
  // Blocks a plan payment must be buried under before it is credited, and an arm before it is re-checked on chain. Off means
  // about 10 seconds of blocks for the chain: 100 on Robinhood Chain (10 blocks a second), 5 on Base (one every 2 seconds).
  CONFIRMATIONS: z.coerce.bigint().min(0n).max(100_000n).optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(120), // reads per address per minute on the public GET routes; 0 is off
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1), // proxies in front of the API that append to X-Forwarded-For (Railway: 1); 0 trusts no header
  KEEPER_MIN_GAS_WEI: z.coerce.bigint().default(500_000_000_000_000n), // warn below 0.0005 ETH
}).superRefine((e, c) => {
  if (e.ALERTS_ONLY) return;
  for (const k of ["ROUTER", "ALARM_BOOK", "ADAPTER_4626", "PLAN_PAY_ADDRESS", "PLAN_TOKEN"] as const) {
    if (!e[k]) c.addIssue({ code: "custom", path: [k], message: "required unless ALERTS_ONLY is on" });
  }
});
export type Env = z.infer<typeof Env>;

/** A blank line in an env file means "not set", not an empty value. */
export const loadEnv = (raw: Record<string, string | undefined>) => Env.parse(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== "")));
