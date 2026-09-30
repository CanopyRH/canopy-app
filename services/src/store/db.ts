import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /** Runs a script behind a lock that every process shares. */
  locked?(sql: string): Promise<void>;
}

export const SCHEMA = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");

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
