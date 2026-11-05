import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** Runs a script behind a lock that every process shares. */
  locked?(sql: string): Promise<void>;
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

/** Production database, using Bun's built-in Postgres client. */
export function postgres(url: string): Db {
  const sql = new Bun.SQL({ url, max: 10 });
  return {
    query: (text, params = []) => sql.unsafe(text, params as never[]) as never,
    exec: async (text) => {
      await sql.unsafe(text).simple();
    },
    locked: async (text) => {
      await sql.begin(async (tx) => {
        await tx.unsafe("SELECT pg_advisory_xact_lock(7226679)");
        await tx.unsafe(text).simple();
      });
    },
  };
}
