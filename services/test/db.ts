import { PGlite } from "@electric-sql/pglite";
import { migrate, postgres, type Db } from "../src/store/db";

let shared: Db | undefined;

/** Real Postgres when TEST_DATABASE_URL is set, otherwise an in-process stand-in. Each call starts empty. */
export async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    shared ??= postgres(url);
    const db = shared;
    await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(db);
    return db;
  }
  const pg = new PGlite();
  const db: Db = {
    query: async (s, p = []) => (await pg.query(s, p as never[])).rows as never,
    exec: async (s) => void (await pg.exec(s)),
    transaction: (fn) => pg.transaction((tx) => fn({
      query: async (s, p = []) => (await tx.query(s, p as never[])).rows as never,
      exec: async (s) => void (await tx.exec(s)),
    })),
  };
  await migrate(db);
  return db;
}
