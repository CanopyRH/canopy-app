import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api/server";
import { handle } from "../src/bot/bot";
import { loadPlugins, PLUGINS, type Plugin } from "../src/plugins";
import { loadSchema } from "../src/store/db";
import { repo } from "../src/store/repo";
import { freshDb } from "./db";

const tmp = () => mkdtempSync(join(tmpdir(), "canopy-plugins-"));

const echo: Plugin = {
  name: "echo",
  api: (app) => void app.get("/echo", (c) => c.json({ ok: true })),
  commands: {
    echo: async ({ arg, chatId }) => ({ text: `${chatId}:${arg}` }),
    start: async () => ({ text: "should never win over the built-in" }),
  },
};

describe("plugins", () => {
  test("the shipped plugins folder loads", () => {
    expect(Array.isArray(PLUGINS)).toBe(true);
  });

  test("loads every plugin file in name order and skips tests", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "b.ts"), `export default { name: "b" };`);
    writeFileSync(join(dir, "a.ts"), `export default { name: "a" };`);
    writeFileSync(join(dir, "a.test.ts"), `throw new Error("not a plugin");`);
    writeFileSync(join(dir, "notes.md"), `not code`);
    expect((await loadPlugins(dir)).map((p) => p.name)).toEqual(["a", "b"]);
  });

  test("refuses a file without a plugin, and two plugins with one name", async () => {
    const bare = tmp();
    writeFileSync(join(bare, "x.ts"), `export const y = 1;`);
    await expect(loadPlugins(bare)).rejects.toThrow("default-export");
    const twice = tmp();
    writeFileSync(join(twice, "a.ts"), `export default { name: "same" };`);
    writeFileSync(join(twice, "b.ts"), `export default { name: "same" };`);
    await expect(loadPlugins(twice)).rejects.toThrow("two plugins");
  });

  test("adds plugin routes to the API after the built-in ones", async () => {
    const db = await freshDb();
    const api = (plugins: Plugin[]) =>
      createApi({ db, repo: repo(db), vaults: async () => [], liveAlarms: async () => [], watchers: [], alarmBook: "0x0000000000000000000000000000000000000001", chainId: 4663, now: () => 0, plugins });
    expect((await api([echo]).request("/echo")).status).toBe(200);
    expect((await api([]).request("/echo")).status).toBe(404);
    expect((await (await api([echo]).request("/vaults")).json())).toEqual([]);
  });

  test("runs plugin bot commands, but built-in commands win", async () => {
    const db = await freshDb();
    const r = repo(db);
    expect((await handle(r, "https://x", 7, "echo", "hi", [], db, [echo])).text).toBe("7:hi");
    expect((await handle(r, "https://x", 7, "start", "", [], db, [echo])).text).not.toContain("never win");
    // Without the database, feature commands are off and the bot answers with its welcome.
    expect((await handle(r, "https://x", 7, "echo", "hi", [], undefined, [echo])).text).not.toBe("7:hi");
  });

  test("feature tables run after the core schema, in name order", () => {
    const dir = tmp();
    writeFileSync(join(dir, "schema.sql"), "-- core");
    mkdirSync(join(dir, "schema.d"));
    writeFileSync(join(dir, "schema.d", "b.sql"), "-- b");
    writeFileSync(join(dir, "schema.d", "a.sql"), "-- a");
    writeFileSync(join(dir, "schema.d", "README.md"), "not sql");
    expect(loadSchema(dir)).toBe("-- core\n-- a\n-- b");
    const none = tmp();
    writeFileSync(join(none, "schema.sql"), "-- core");
    expect(loadSchema(none)).toBe("-- core");
  });
});
