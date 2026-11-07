import { z } from "zod";
import { watcherProblems, withWatcherDefaults } from "./watcher/quickstart";

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const ROLES = ["all", "api", "bot", "indexer", "detector", "watcher", "keeper"] as const;
export type Role = (typeof ROLES)[number];
export const hasRole = (roles: readonly Role[], role: Role) => roles.includes("all") || roles.includes(role);

export const Env = z.object({
  // One role, several joined by commas (an independent keeper runs "indexer,keeper"), or "all".
  ROLE: z.string().default("all").transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.enum(ROLES)).min(1)),
  PORT: z.coerce.number().default(8443), // Telegram webhooks: 443/80/88/8443 only, TLS 1.2+, IPv4
  PUBLIC_URL: z.url().optional(), // this service's own address, for the Telegram webhook; needed by the api and bot roles
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
  // Set to the new ROUTER for the one deploy that moves the shared database to new contracts. Without it a service whose
  // ROUTER/ALARM_BOOK differ from the stored ones refuses to start. Remove it once every service is running on the new addresses.
  CONTRACT_SWITCH: addr.optional(),
  // The v1 contracts, while they are live. The indexer follows their admin events and new arms and tells the ops chat, because
  // nothing keeps v1 positions safe once the services run on v2. Off means v1 is not followed. Remove both when v1 retires.
  V1_ROUTER: addr.optional(),
  V1_ALARM_BOOK: addr.optional(),
  V1_START_BLOCK: z.coerce.bigint().min(0n).optional(), // where to start reading the v1 contracts; off means START_BLOCK
  // One exit paying out more than this much of the stablecoin, or one vault's exits adding up to more within an hour, tells
  // the ops chat. Whole stablecoin units (6 decimals on the router), so 50000 is 50,000 USDG. 0 turns it off.
  OUTFLOW_ALERT: z.coerce.number().min(0).default(50_000),
  PLAN_PAY_ADDRESS: addr.optional(), // receives prepaid plan payments; a multisig
  PLAN_TOKEN: addr.optional(),
  KEEPER_PRIVATE_KEY: z.string().optional(), // pays gas only; holds no user funds
  KEEPER_PAID_ONLY: z.stringbool().default(true),
  KEEPER_UNLISTED_EXIT_GAS: z.coerce.bigint().min(500_000n).max(16_000_000n).default(4_000_000n), // gas cap for an exit from a vault not in CARD_VAULTS
  KEEPER_CHECK_GAS: z.coerce.bigint().min(5_000_000n).max(100_000_000n).default(30_000_000n), // gas of each batched alarm check (20 keys); lower it if the RPC refuses calls this large
  QUORUM: z.coerce.number().default(2),
  WATCHER_PRIVATE_KEY: z.string().optional(),
  WATCHERS: z.string().default(""), // comma-separated approved watcher addresses
  WATCHER_PROFILE_FILE: z.string().min(1).optional(), // locally reviewed operator/model/source identities; strict diversity when set
  WATCHER_EVIDENCE_DIR: z.string().min(1).optional(), // archive a bundle before publishing each signature
  WATCHER_PEERS: z.string().default(""), // comma-separated peer API URLs for attestation gossip
  FEED_URLS: z.string().default(""), // comma-separated allowlisted public sources
  LP_POOLS: z.string().default("").refine(v=>v===""||v.split(",").every(a=>/^0x[0-9a-fA-F]{40}$/.test(a.trim())), "Use comma-separated reviewed pool addresses"),
  CARD_VAULTS: z.string().default(""), // comma-separated vaults that always get a risk card
  ANTHROPIC_API_KEY: z.string().optional(), // classification only
  ANTHROPIC_BASE_URL: z.url().optional(), // a compatible service such as PPQ; off means Anthropic directly
  CLASSIFIER_MODEL: z.string().min(1).optional(), // that service's model name
  TELEGRAM_BOT_TOKEN: z.string().optional(), // off means no alerts; needed by the api and bot roles
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
  BOT_MODE: z.enum(["webhook", "polling"]).default("webhook"),
  TELEGRAM_API_ROOT: z.url().optional(), // local test server only
  LOOP_SCALE: z.coerce.number().positive().default(1), // shortens loop intervals in local runs
  OPS_CHAT_ID: z.coerce.number().optional(), // Telegram chat for operator warnings
  HEALTH_TOKEN: z.string().min(16).optional(), // bearer token for GET /health; off without one
  // Blocks a plan payment must be buried under before it is credited, and an arm before it is re-checked on chain. Off means
  // about 10 seconds of blocks for the chain: 100 on Robinhood Chain (10 blocks a second), 5 on Base (one every 2 seconds).
  CONFIRMATIONS: z.coerce.bigint().min(0n).max(100_000n).optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(120), // reads per address per minute on the public GET routes; 0 is off
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1), // entries at the end of X-Forwarded-For that your proxies add (Railway: 2, the caller then its edge server); 0 trusts no header
  KEEPER_MIN_GAS_WEI: z.coerce.bigint().default(500_000_000_000_000n), // warn below 0.0005 ETH
}).superRefine((e, c) => {
  for (const [k, v] of [["V1_ROUTER", e.ROUTER], ["V1_ALARM_BOOK", e.ALARM_BOOK]] as const) {
    if (e[k] && v && e[k]!.toLowerCase() === v.toLowerCase()) c.addIssue({ code: "custom", path: [k], message: "must be the v1 contract, not the one this service runs on" });
  }
  // A watcher needs the AlarmBook and its own settings, not the router, adapter or plan payment. See watcher/quickstart.ts.
  if (e.ROLE.every((r) => r === "watcher")) return void watcherProblems(e).forEach((p) => c.addIssue({ code: "custom", path: [p.path], message: p.message }));
  const need = (k: keyof typeof e, message: string) => {
    if (e[k] === undefined) c.addIssue({ code: "custom", path: [k], message });
  };
  if (!e.ALERTS_ONLY) {
    for (const k of ["ROUTER", "ALARM_BOOK", "ADAPTER_4626"] as const) need(k, "required unless ALERTS_ONLY is on");
    // Payments only matter to a keeper that serves paid wallets. An independent keeper serving everyone skips them.
    if (e.KEEPER_PAID_ONLY) for (const k of ["PLAN_PAY_ADDRESS", "PLAN_TOKEN"] as const) need(k, "required while KEEPER_PAID_ONLY is on");
  }
  if (hasRole(e.ROLE, "api") || hasRole(e.ROLE, "bot")) {
    for (const k of ["PUBLIC_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"] as const) need(k, "required by the api and bot roles");
  }
  if (e.TELEGRAM_BOT_TOKEN !== undefined && e.APP_URL === undefined && e.PUBLIC_URL === undefined) {
    need("APP_URL", "the bot needs APP_URL or PUBLIC_URL for its Open Canopy button");
  }
});
export type Env = z.infer<typeof Env>;

/** A blank line in an env file means "not set", not an empty value. */
export const loadEnv = (raw: Record<string, string | undefined>) => Env.parse(withWatcherDefaults(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ""))));
