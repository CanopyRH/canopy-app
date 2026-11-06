import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findBanned } from "../../tools/banned-words";
import { WALLETS_COPY, capNote } from "../src/app/wallets/copy";
import { addWallet, cleanLabel, loadList, MAX_LABEL, MAX_WALLETS, parseList, removeWallet, saveList, setLabel, shown, STORAGE_KEY, totals, type Saved, type Store } from "../src/app/wallets/list";
import sanctioned from "../src/sanctioned.json";

const a = (n: number) => `0x${n.toString(16).padStart(4, "0").repeat(10)}`;
const memory = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};
const broken: Store = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("full"); },
  removeItem: () => { throw new Error("blocked"); },
};

test("adds a wallet, checksums it and keeps the label", () => {
  const r = addWallet([], ` ${a(0xabab).toUpperCase().replace("0X", "0x")} `, "  Cold   wallet ");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.list).toHaveLength(1);
  expect(r.list[0]!.address.toLowerCase()).toBe(a(0xabab));
  expect(r.list[0]!.label).toBe("Cold   wallet");
});

test("rejects bad addresses, duplicates in any case, and blocked addresses", () => {
  const first = addWallet([], a(1));
  if (!first.ok) throw new Error("setup");
  for (const bad of ["", "abc", "0x123", a(2) + "00", "vitalik.eth", "0xZZ" + a(3).slice(4)]) expect(addWallet(first.list, bad)).toEqual({ ok: false, error: "bad" });
  expect(addWallet(first.list, a(1).toUpperCase().replace("0X", "0x"))).toEqual({ ok: false, error: "duplicate" });
  expect(addWallet([], sanctioned.addresses[0]!)).toEqual({ ok: false, error: "blocked" });
});

test("caps the list", () => {
  let list: Saved[] = [];
  for (let i = 1; i <= MAX_WALLETS; i++) {
    const r = addWallet(list, a(i));
    if (!r.ok) throw new Error("setup");
    list = r.list;
  }
  expect(list).toHaveLength(MAX_WALLETS);
  expect(addWallet(list, a(99))).toEqual({ ok: false, error: "full" });
  expect(MAX_WALLETS).toBeGreaterThanOrEqual(5);
  expect(MAX_WALLETS).toBeLessThanOrEqual(25);
});

test("removes, relabels and clears without touching other entries", () => {
  const list = parseList([{ address: a(1), label: "one" }, { address: a(2), label: "two" }]);
  expect(removeWallet(list, a(1).toUpperCase().replace("0X", "0x")).map((w) => w.label)).toEqual(["two"]);
  expect(setLabel(list, a(2), "  renamed ").map((w) => w.label)).toEqual(["one", "renamed"]);
  expect(setLabel(list, a(2), "").map((w) => w.label)).toEqual(["one", ""]);
  expect(removeWallet(list, a(9))).toEqual(list);
});

test("labels are one line and short", () => {
  expect(cleanLabel("a\nb\u0000c")).toBe("a b c");
  expect(cleanLabel("x".repeat(500))).toHaveLength(MAX_LABEL);
  expect(cleanLabel(42)).toBe("");
  expect(cleanLabel(null)).toBe("");
});

test("the list round-trips through storage and clearing removes the key", () => {
  const store = memory();
  const r = addWallet([], a(5), "five");
  if (!r.ok) throw new Error("setup");
  expect(saveList(r.list, store)).toBe(true);
  expect(loadList(store)).toEqual(r.list);
  expect(saveList([], store)).toBe(true);
  expect(store.data.has(STORAGE_KEY)).toBe(false);
  expect(loadList(store)).toEqual([]);
});

test("damaged or edited storage is cleaned up, not trusted", () => {
  const store = memory();
  store.setItem(STORAGE_KEY, "{not json");
  expect(loadList(store)).toEqual([]);
  store.setItem(STORAGE_KEY, JSON.stringify({ address: a(1) }));
  expect(loadList(store)).toEqual([]);
  const many = Array.from({ length: MAX_WALLETS + 8 }, (_, i) => ({ address: a(i + 1), label: "x" }));
  store.setItem(STORAGE_KEY, JSON.stringify([null, 7, { address: 5 }, { address: "nope" }, { address: a(1), label: 9 }, { address: a(1) }, { address: sanctioned.addresses[0] }, ...many]));
  const list = loadList(store);
  expect(list).toHaveLength(MAX_WALLETS);
  expect(list[0]).toEqual({ address: expect.any(String), label: "" });
  expect(new Set(list.map((w) => w.address.toLowerCase())).size).toBe(list.length);
  expect(list.some((w) => sanctioned.addresses.includes(w.address.toLowerCase()))).toBe(false);
});

test("the app still works when storage throws or does not exist", () => {
  expect(loadList(broken)).toEqual([]);
  expect(saveList([{ address: a(1) as `0x${string}`, label: "" }], broken)).toBe(false);
  expect(saveList([], broken)).toBe(false);
  expect(loadList(null)).toEqual([]);
  expect(saveList([], null)).toBe(false);
  // No localStorage in this test runtime, so the default store is the missing case too.
  expect(loadList()).toEqual([]);
});

test("the connected wallet shows first, once, and is saved only on request", () => {
  const saved = parseList([{ address: a(1), label: "one" }, { address: a(2), label: "two" }]);
  const me = a(3) as `0x${string}`;
  const unsaved = shown(saved, me);
  expect(unsaved.map((w) => [w.address, w.connected, w.saved])).toEqual([[me, true, false], [saved[0]!.address, false, true], [saved[1]!.address, false, true]]);
  expect(saved).toHaveLength(2);
  const already = shown(saved, saved[1]!.address.toLowerCase() as `0x${string}`);
  expect(already).toHaveLength(2);
  expect(already[0]).toMatchObject({ connected: true, saved: true, label: "two" });
  expect(shown(saved, null).every((w) => !w.connected && w.saved)).toBe(true);
});

test("the total adds every wallet's positions", () => {
  expect(totals([])).toEqual({ total: 0n, armed: 0n, positions: 0 });
  const t = totals([[{ assets: 5_000_000n, armed: true }, { assets: 2_500_000n, armed: false }], [], [{ assets: 1_000_000n, armed: true }]]);
  expect(t).toEqual({ total: 8_500_000n, armed: 6_000_000n, positions: 3 });
});

test("the words are plain and pass the banned-word check", () => {
  const all = JSON.stringify(WALLETS_COPY) + capNote(MAX_WALLETS);
  expect(findBanned(all)).toEqual([]);
  expect(WALLETS_COPY.privacy).toContain("never sent to Canopy");
  expect(WALLETS_COPY.privacy.split(/[.!?]\s/).length).toBeLessThanOrEqual(2);
});

test("the wallet code never sends a wallet anywhere but the chain reads", () => {
  const dir = join(import.meta.dir, "../src/app/wallets");
  for (const f of readdirSync(dir).filter((f) => /\.tsx?$/.test(f))) {
    const code = readFileSync(join(dir, f), "utf8");
    for (const banned of [/\bfetch\s*\(/, /apiUrl/, /sendBeacon/, /XMLHttpRequest/, /WebSocket/, /sendTx/, /\.request\s*\(/]) expect(`${f} ${banned}: ${banned.test(code)}`).toBe(`${f} ${banned}: false`);
  }
  // The only network call that touches a vault list is the existing one, which asks for every launch vault and no wallet.
  const chain = readFileSync(join(import.meta.dir, "../src/chain.ts"), "utf8");
  expect(chain.match(/fetch\(`[^`]*`/g)).toEqual(["fetch(`${c.apiUrl}/risk/${v.address}`"]);
});
