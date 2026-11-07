import { Glob } from "bun";
import { join } from "node:path";
import type { Hono } from "hono";
import type { PublicClient } from "viem";
import type { ApiDeps } from "./api/server";
import type { Reply } from "./bot/bot";
import type { ReorgInfo } from "./indexer/indexer";
import type { StuckLog } from "./indexer/retry";
import type { Db } from "./store/db";
import type { Role } from "./env";
import type { Repo } from "./store/repo";

/** What a bot command gets. Like the built-in commands, it may store chats and vaults, never wallets. */
export interface CommandCtx {
  db: Db;
  repo: Repo;
  chatId: number;
  arg: string;
  appUrl: string;
}

/** What a plugin's background loops get from the running service. */
export interface Runtime {
  client: PublicClient;
  db: Db;
  repo: Repo;
  chainId: number;
  /** Seconds. */
  now: () => number;
  /** Whether this process runs the role (always true for "all"). */
  run: (role: Role) => boolean;
  /** False on a chain with no Canopy contracts, where the detector role sends the free alerts instead of the indexer. */
  contracts: boolean;
  /** The vaults the app lists (CARD_VAULTS), lowercase. */
  listed: string[];
  /** Blocks to hold back from the chain head before a log is trusted. */
  confirmations: bigint;
  /** Runs a loop forever at this interval (before LOOP_SCALE). A failed pass is logged and retried. */
  every: (baseMs: number, name: string, fn: () => Promise<unknown>) => void;
  /** Throws when the database belongs to other contracts. Call it at the start of a pass that writes. */
  fence?: () => Promise<void>;
  /** Report a stuck log or a deep reorg the way the core readers do. Both only queue an operator message. */
  onStuck: (s: StuckLog) => Promise<unknown>;
  onDeepReorg: (i: ReorgInfo) => Promise<unknown>;
  /** Queues a follower alert for a vault (see bot/queue.ts). */
  queueAlert: (vault: string, text: string, tag?: string, topic?: string) => Promise<unknown>;
  /** The web app's address, for links in alerts. */
  appUrl: string;
}

/**
 * A feature added on top of the core services. Each file in src/plugins/ default-exports one, and its tables go in
 * src/store/schema.d/, so a new feature adds files and changes none. That keeps feature branches from touching the
 * same lines, so each one rebases onto main cleanly.
 */
export interface Plugin {
  name: string;
  /** Adds routes after the built-in ones, which win on a clash. The API's CORS and read-only rules still apply. */
  api?: (app: Hono, d: ApiDeps) => void;
  /** Bot commands by name, without the slash. Built-in commands win on a clash. */
  commands?: Record<string, (c: CommandCtx) => Promise<Reply>>;
  /** Starts the feature's background loops, once, after the service has set up. */
  start?: (rt: Runtime) => void;
}

export async function loadPlugins(dir = join(import.meta.dir, "plugins")): Promise<Plugin[]> {
  const files = [...new Glob("*.ts").scanSync(dir)].filter((f) => !f.endsWith(".test.ts")).sort();
  const loaded = await Promise.all(files.map(async (f) => (await import(join(dir, f))).default as Plugin));
  const names = new Set<string>();
  for (const p of loaded) {
    if (!p?.name) throw new Error("a file in plugins/ does not default-export a plugin with a name");
    if (names.has(p.name)) throw new Error(`two plugins are named ${p.name}`);
    names.add(p.name);
  }
  return loaded;
}

export const PLUGINS = await loadPlugins();
