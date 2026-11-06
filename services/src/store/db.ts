import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** Runs a script behind a lock that every process shares. */
  locked?(sql: string): Promise<void>;
  /** Runs `fn` in one transaction: all of its queries commit together or not at all. */
  transaction?<T>(fn: (q: Db) => Promise<T>): Promise<T>;
}

/** The core tables, then each feature's own file from schema.d/ in name order. */
export function loadSchema(dir = import.meta.dir) {
  const extra = join(dir, "schema.d");
  const files = existsSync(extra) ? readdirSync(extra).filter((f) => f.endsWith(".sql")).sort() : [];
  return [join(dir, "schema.sql"), ...files.map((f) => join(extra, f))].map((f) => readFileSync(f, "utf8")).join("\n");
}

export const SCHEMA = loadSchema();

/** Roles start together, and two processes creating the same table at once fail, so migrations take turns. */
export async function migrate(db: Db) {
  await (db.locked ?? db.exec)(SCHEMA);
}

/**
 * Connections each process may hold. Every service shares one database, and during a deploy the old and new copy of
 * each service run side by side, so a small pool keeps a full rollout well under the server's limit (100 by default).
 */
export const DEFAULT_POOL = 4;

/** Production database, using Bun's built-in Postgres client. */
export function postgres(url: string, max = DEFAULT_POOL): Db {
  const sql = new Bun.SQL({ url, max });
  return {
    query: (text, params = []) => sql.unsafe(text, params as never[]) as never,
    exec: async (text) => {
      await sql.unsafe(text).simple();
    },
    transaction: (fn) =>
      sql.begin((tx) => fn({
        query: (text, params = []) => tx.unsafe(text, params as never[]) as never,
        exec: async (text) => {
          await tx.unsafe(text).simple();
        },
      })),
    locked: async (text) => {
      await sql.begin(async (tx) => {
        await tx.unsafe("SELECT pg_advisory_xact_lock(7226679)");
        await tx.unsafe(text).simple();
      });
    },
  };
}
