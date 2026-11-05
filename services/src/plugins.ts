import { Glob } from "bun";
import { join } from "node:path";
import type { Hono } from "hono";
import type { ApiDeps } from "./api/server";
import type { Reply } from "./bot/bot";
import type { Db } from "./store/db";
import type { Repo } from "./store/repo";

/** What a bot command gets. Like the built-in commands, it may store chats and vaults, never wallets. */
export interface CommandCtx {
  db: Db;
  repo: Repo;
  chatId: number;
  arg: string;
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
