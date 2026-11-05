import { describe, expect, test } from "bun:test";
import { COPY } from "../src/copy/text";
import type { OpenWalletConnect } from "../src/walletconnect/load";

/** A page that records the scripts it is asked to load, and lets the test decide how each load ends. */
function page() {
  const added: { src: string; onload?: () => void; onerror?: () => void }[] = [];
  const doc = {
    createElement: () => ({}) as never,
    head: { appendChild: (s: { src: string; onload?: () => void; onerror?: () => void }) => void added.push(s) },
  } as unknown as Document;
  return { doc, added };
}

// load.ts keeps one load per page, so each case takes a fresh copy of the module.
const fresh = async () => (await import(`../src/walletconnect/load.ts?${Math.random()}`)) as typeof import("../src/walletconnect/load");

describe("WalletConnect loading", () => {
  test("wc.js loads once, only when asked, and hands back the opener", async () => {
    const { loadWalletConnect } = await fresh();
    const { doc, added } = page();
    const open = (async () => ({ request: async () => null })) as OpenWalletConnect;
    const host: { canopyWalletConnect?: OpenWalletConnect } = {};
    const a = loadWalletConnect(doc, host);
    const b = loadWalletConnect(doc, host);
    expect(added.map((s) => s.src)).toEqual(["wc.js"]);
    host.canopyWalletConnect = open;
    added[0]!.onload!();
    expect(await a).toBe(open);
    expect(await b).toBe(open);
  });

  test("a failed load says so in plain words and can be tried again", async () => {
    const { loadWalletConnect } = await fresh();
    const { doc, added } = page();
    const host: { canopyWalletConnect?: OpenWalletConnect } = {};
    const first = loadWalletConnect(doc, host);
    added[0]!.onerror!();
    expect(first).rejects.toThrow(COPY.phoneWalletFailed);
    await first.catch(() => {});
    void loadWalletConnect(doc, host);
    expect(added.length).toBe(2);
  });
});
