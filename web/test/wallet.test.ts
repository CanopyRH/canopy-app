import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { COPY } from "../src/copy/text";
import { friendly, safeIcon, sendTx, walletChoice, watchWallets, type Eip1193, type FoundWallet } from "../src/wallet";

const FROM = "0x00000000000000000000000000000000000000a1" as Address;
const TX = { to: "0x00000000000000000000000000000000000000a2" as Address, data: "0x12" as Hex };
const HASH = `0x${"ab".repeat(32)}` as Hex;
const NET = { chainHex: "0x1237", chainName: "Robinhood Chain", rpcUrl: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com" };

/** knows: the wallet already has the network. adds: it accepts a request to add it. */
function wallet(start: string, switches = true, knows = true, adds = true) {
  let chain = start;
  let known = knows;
  const calls: string[] = [];
  const added: unknown[] = [];
  const w: Eip1193 = {
    request: async ({ method, params }) => {
      calls.push(method);
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") {
        if (!switches) throw Object.assign(new Error("user rejected"), { code: 4001 });
        if (!known) throw Object.assign(new Error("unrecognized chain"), { code: 4902 });
        chain = (params![0] as { chainId: string }).chainId;
        return null;
      }
      if (method === "wallet_addEthereumChain") {
        added.push(params![0]);
        if (!adds) throw new Error("refused");
        known = true;
        chain = (params![0] as { chainId: string }).chainId;
        return null;
      }
      return HASH;
    },
  };
  return { w, calls, added };
}
const mined = (status: string, replaced?: string) => ({
  waitForTransactionReceipt: async (a: { onReplaced?: (r: { reason: string }) => void }) => {
    if (replaced) a.onReplaced?.({ reason: replaced });
    return { status };
  },
});

describe("finding wallets", () => {
  const provider: Eip1193 = { request: async () => null };
  const found = (uuid: string, name = uuid): FoundWallet => ({ info: { uuid, name, icon: "" }, provider });
  const announce = (page: EventTarget, detail: unknown) => page.dispatchEvent(Object.assign(new Event("eip6963:announceProvider"), { detail }));

  test("the page asks, and hears every wallet that answers", () => {
    const page = new EventTarget();
    let asked = false;
    page.addEventListener("eip6963:requestProvider", () => (asked = true));
    let seen: FoundWallet[] = [];
    watchWallets(page, (all) => (seen = all));
    expect(asked).toBe(true);
    announce(page, found("a"));
    announce(page, found("b"));
    expect(seen.map((w) => w.info.name)).toEqual(["a", "b"]);
  });

  test("a wallet that answers twice is listed once", () => {
    const page = new EventTarget();
    let seen: FoundWallet[] = [];
    watchWallets(page, (all) => (seen = all));
    announce(page, found("a"));
    announce(page, found("a"));
    expect(seen.length).toBe(1);
  });

  test("a malformed answer is ignored", () => {
    const page = new EventTarget();
    let seen: FoundWallet[] = [];
    watchWallets(page, (all) => (seen = all));
    for (const bad of [undefined, {}, { info: { uuid: "x", name: "x" } }, { info: { uuid: "x", name: "x" }, provider: {} }]) announce(page, bad);
    expect(seen).toEqual([]);
  });

  test("two wallets ask for a choice, however window.ethereum is set", () => {
    expect(walletChoice([found("a"), found("b")], provider)).toEqual({ pick: [found("a"), found("b")] });
  });

  test("one wallet connects straight away, and an older wallet still works", () => {
    expect(walletChoice([found("a")])).toEqual({ use: provider });
    expect(walletChoice([], provider)).toEqual({ use: provider });
    expect(walletChoice([])).toBeNull();
  });

  test("only an inline icon is shown", () => {
    expect(safeIcon("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    for (const bad of ["https://tracker.test/x.png", "javascript:alert(1)", ""]) expect(safeIcon(bad)).toBeNull();
  });
});

describe("sending", () => {
  test("the right network sends straight away and waits for the receipt", async () => {
    const { w, calls } = wallet("0x1237");
    expect(await sendTx(w, mined("success"), FROM, TX, NET)).toBe(HASH);
    expect(calls).toEqual(["eth_chainId", "eth_sendTransaction"]);
  });

  test("the same network in another format counts", async () => {
    const { w, calls } = wallet("0x01237");
    await sendTx(w, mined("success"), FROM, TX, NET);
    expect(calls).not.toContain("wallet_switchEthereumChain");
  });

  test("the wrong network switches first", async () => {
    const { w, calls } = wallet("0x1");
    await sendTx(w, mined("success"), FROM, TX, NET);
    expect(calls).toEqual(["eth_chainId", "wallet_switchEthereumChain", "eth_chainId", "eth_sendTransaction"]);
  });

  test("a wallet without Robinhood Chain is asked to add it, then sends", async () => {
    const { w, calls, added } = wallet("0x2105", true, false);
    expect(await sendTx(w, mined("success"), FROM, TX, NET)).toBe(HASH);
    expect(calls).toContain("wallet_addEthereumChain");
    expect(added).toEqual([{ chainId: "0x1237", chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [NET.rpcUrl], blockExplorerUrls: [NET.explorer] }]);
  });

  test("a wallet that refuses to add the network sends nothing", async () => {
    const { w, calls } = wallet("0x2105", true, false, false);
    await expect(sendTx(w, mined("success"), FROM, TX, NET)).rejects.toThrow(COPY.wrongChain);
    expect(calls).not.toContain("eth_sendTransaction");
  });
});
