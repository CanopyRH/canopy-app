import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isAddress, type Address } from "viem";
import { autoExit, CHAINS, CONFIG, offered, pick, planScope, saveChain, savedChain, type Chain } from "../src/config";
import { network } from "../src/chain";
import { ensureChain, type Eip1193 } from "../src/wallet";
import { phoneOptions } from "../src/walletconnect/load";
import mainnet from "../src/mainnet.json";
import mainnetBase from "../src/mainnet.base.json";
import { COPY } from "../src/copy/text";
import { findBanned } from "../../tools/banned-words";

const [robinhood, base] = CHAINS as [Chain, Chain];
const settings = JSON.parse(readFileSync(join(import.meta.dir, "../../deploy/settings.base.example.json"), "utf8")) as { chainId: number; stable: string; vaults: string[] };
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
/** Base as it will be once deployed, with sample contract addresses. */
const baseLive: Chain = { ...base, router: A(1), adapter: A(2), alarmBook: A(3), planPayTo: A(4), apiUrl: "https://api.example.invalid" };

/** A store that keeps what it is given, or one where storage is blocked. */
function store(blocked = false) {
  const m = new Map<string, string>();
  const no = () => {
    throw new Error("SecurityError");
  };
  return { getItem: (k: string) => (blocked ? no() : (m.get(k) ?? null)), setItem: (k: string, v: string) => (blocked ? no() : void m.set(k, v)), m };
}

describe("per-chain config", () => {
  test("Robinhood Chain comes first and keeps its launch values", () => {
    expect(CONFIG).toBe(robinhood);
    expect(robinhood).toMatchObject({ key: "robinhood", chainId: 4663, chainHex: "0x1237", chainName: "Robinhood Chain", rpcUrl: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com", planToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", planTokenSymbol: "USDG" });
    expect(robinhood).toMatchObject(mainnet);
    expect(robinhood.vaults.length).toBe(5);
    expect(autoExit(robinhood)).toBe(true);
  });

  test("Base has its own network, USDC plans and the 11 launch vaults", () => {
    expect(base).toMatchObject({ key: "base", chainId: 8453, chainHex: "0x2105", chainName: "Base", rpcUrl: "https://mainnet.base.org", explorer: "https://basescan.org", planToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", planTokenSymbol: "USDC" });
    expect(base.chainId).toBe(settings.chainId);
    expect(base.planToken).toBe(settings.stable as Address);
    expect(base.vaults.map((v) => v.address)).toEqual(settings.vaults as Address[]);
    expect(base.vaults.every((v) => v.asset === "USDC" && v.name.length > 0)).toBe(true);
  });

  // services/deploy/web-base-config.ts fills mainnet.base.json at release, from deploy/out/8453/deployment.json. Until then it is
  // all null and Base is hidden. Once filled, it must be exactly that deployment: never a fork rehearsal's addresses.
  test("Base contracts stay null until the Base deploy, then match the recorded Base deployment", () => {
    // mainnet.base.json fills the same address fields as mainnet.json.
    expect(Object.keys(mainnetBase).sort()).toEqual(Object.keys(mainnet).sort());
    if (mainnetBase.router === null) {
      expect(mainnetBase).toEqual({ router: null, adapter: null, alarmBook: null, deployBlock: null, planPayTo: null, apiUrl: "", walletConnectProjectId: null });
      expect([base.router, base.adapter, base.alarmBook, base.planPayTo]).toEqual([null, null, null, null]);
      expect(offered(CHAINS)).toEqual([robinhood]);
      return;
    }
    // The deploy record is private (deploy/out isn't in the public repo), so a public checkout only checks the shape above.
    const record = join(import.meta.dir, "../../deploy/out/8453/deployment.json");
    if (!existsSync(record)) return;
    const d = JSON.parse(readFileSync(record, "utf8")) as { router: string; adapter: string; alarmBook: string; settings: { chainId: number; planPayTo: string; apiUrl: string } };
    expect(d.settings.chainId).toBe(8453);
    expect(mainnetBase).toMatchObject({ router: d.router, adapter: d.adapter, alarmBook: d.alarmBook, planPayTo: d.settings.planPayTo, deployBlock: (d as unknown as { startBlock: number }).startBlock });
    expect(mainnetBase.apiUrl).toStartWith("https://");
    const rehearsalFile = join(import.meta.dir, "../../deploy/out/8453-rehearsal/deployment.json");
    if (!existsSync(rehearsalFile)) return;
    const rehearsal = JSON.parse(readFileSync(rehearsalFile, "utf8")) as { router: string };
    expect((mainnetBase.router as string).toLowerCase()).not.toBe(rehearsal.router.toLowerCase());
  });

  test("one WalletConnect project serves both networks", () => {
    expect(base.walletConnectProjectId).toBe(robinhood.walletConnectProjectId);
  });

  test("every network's hex id, vaults and tokens are well formed", () => {
    for (const c of CHAINS) {
      expect(parseInt(c.chainHex, 16)).toBe(c.chainId);
      expect(c.rpcUrl).toStartWith("https://");
      expect(c.explorer).toStartWith("https://");
      expect(isAddress(c.planToken)).toBe(true);
      for (const v of c.vaults) expect(isAddress(v.address)).toBe(true);
      expect(new Set(c.vaults.map((v) => v.address.toLowerCase())).size).toBe(c.vaults.length);
    }
    expect(new Set(CHAINS.map((c) => c.key)).size).toBe(CHAINS.length);
  });
});

describe("contracts null means no auto-exit", () => {
  test("any missing contract turns auto-exit off", () => {
    expect(autoExit(base)).toBe(false);
    expect(autoExit(baseLive)).toBe(true);
    for (const k of ["router", "adapter", "alarmBook"] as const) expect(autoExit({ ...baseLive, [k]: null })).toBe(false);
  });

  test("a network with no contracts isn't offered, so the app looks as it did before Base", () => {
    expect(offered(CHAINS)).toEqual([robinhood]);
    expect(offered([robinhood, { ...baseLive, router: null }])).toEqual([robinhood]);
  });

  test("Base is offered next to Robinhood Chain once its contracts are set", () => {
    expect(offered([robinhood, baseLive]).map((c) => c.key)).toEqual(["robinhood", "base"]);
  });

  test("with no network live, the first stays as check-only", () => {
    const off = { ...robinhood, router: null };
    expect(offered([off, base])).toEqual([off]);
  });

  test("a network's reads skip the router when it has no contracts", async () => {
    const n = network(base);
    expect(n.live).toBe(false);
    expect(await n.armState(A(9), base.vaults[0]!.address)).toBeNull();
    expect(network(base)).toBe(n);
    expect(network(robinhood)).not.toBe(n);
    expect(network(robinhood).live).toBe(true);
  });

  test("a network with no API has no risk cards and fetches nothing", async () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => (calls++, new Response("{}"))) as unknown as typeof fetch;
    try {
      expect(await network(base).riskCard(base.vaults[0]!.address)).toBeNull();
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("choosing a network", () => {
  test("the saved choice wins if it is offered, and anything else falls back to the first", () => {
    const both = [robinhood, baseLive];
    expect(pick(both, "base")).toBe(baseLive);
    expect(pick(both, "robinhood")).toBe(robinhood);
    expect(pick(both, null)).toBe(robinhood);
    expect(pick(both, "nonsense")).toBe(robinhood);
    // Saved before Base was hidden again: Robinhood Chain, not a network with no contracts.
    expect(pick(offered(CHAINS), "base")).toBe(robinhood);
  });

  test("the choice is remembered", () => {
    const s = store();
    expect(savedChain(s)).toBeNull();
    saveChain("base", s);
    expect(savedChain(s)).toBe("base");
    expect([...s.m.values()]).toEqual(["base"]);
  });

  test("blocked or missing storage forgets the choice and never throws", () => {
    const s = store(true);
    expect(() => saveChain("base", s)).not.toThrow();
    expect(savedChain(s)).toBeNull();
    // Bun has no localStorage, so this is the missing-storage case.
    expect(() => saveChain("base")).not.toThrow();
    expect(savedChain()).toBeNull();
  });
});

describe("switching the wallet's network", () => {
  /** A wallet on Robinhood Chain that may not know Base yet. */
  function wallet(knowsBase: boolean) {
    let chain = "0x1237";
    let known = knowsBase;
    const calls: { method: string; params?: unknown[] }[] = [];
    const w: Eip1193 = {
      request: async (a) => {
        calls.push(a);
        if (a.method === "eth_chainId") return chain;
        if (a.method === "wallet_switchEthereumChain") {
          if (!known) throw Object.assign(new Error("unrecognized chain"), { code: 4902 });
          chain = (a.params![0] as { chainId: string }).chainId;
          return null;
        }
        if (a.method === "wallet_addEthereumChain") {
          known = true;
          chain = (a.params![0] as { chainId: string }).chainId;
          return null;
        }
        throw new Error(`unexpected ${a.method}`);
      },
    };
    return { w, calls, chain: () => chain };
  }

  test("a wallet that knows Base is switched to it", async () => {
    const { w, calls, chain } = wallet(true);
    await ensureChain(w, base);
    expect(chain()).toBe("0x2105");
    expect(calls.find((c) => c.method === "wallet_switchEthereumChain")?.params).toEqual([{ chainId: "0x2105" }]);
    expect(calls.some((c) => c.method === "wallet_addEthereumChain")).toBe(false);
  });

  test("a wallet without Base is asked to add it with Base's RPC and explorer", async () => {
    const { w, calls, chain } = wallet(false);
    await ensureChain(w, base);
    expect(chain()).toBe("0x2105");
    expect(calls.find((c) => c.method === "wallet_addEthereumChain")?.params).toEqual([
      { chainId: "0x2105", chainName: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] },
    ]);
  });

  test("and back to Robinhood Chain", async () => {
    const { w, chain } = wallet(true);
    await ensureChain(w, base);
    await ensureChain(w, robinhood);
    expect(chain()).toBe("0x1237");
  });
});

describe("WalletConnect asks for the selected network", () => {
  test("Robinhood Chain alone asks for Robinhood Chain only, as before", () => {
    expect(phoneOptions(robinhood, offered(CHAINS), "d")).toEqual({ projectId: robinhood.walletConnectProjectId!, chainId: 4663, rpcUrl: robinhood.rpcUrl, description: "d", more: [] });
  });

  test("the selected network comes first, and the other is there to switch to", () => {
    const both = [robinhood, baseLive];
    expect(phoneOptions(baseLive, both, "d")).toMatchObject({ chainId: 8453, rpcUrl: "https://mainnet.base.org", more: [{ chainId: 4663, rpcUrl: robinhood.rpcUrl }] });
    expect(phoneOptions(robinhood, both, "d")).toMatchObject({ chainId: 4663, more: [{ chainId: 8453, rpcUrl: "https://mainnet.base.org" }] });
  });
});

describe("plans are per network", () => {
  test("with one network, the Plan screen adds nothing", () => {
    expect(planScope(robinhood, offered(CHAINS))).toBeNull();
  });

  test("with two, it says plainly that a plan covers one network", () => {
    const both = [robinhood, baseLive];
    expect(planScope(baseLive, both)).toBe("Plans are per network. This plan is paid in USDC on Base and covers Base only. A plan on Robinhood Chain is paid for separately.");
    expect(planScope(robinhood, both)).toBe("Plans are per network. This plan is paid in USDG on Robinhood Chain and covers Robinhood Chain only. A plan on Base is paid for separately.");
    expect(findBanned(planScope(baseLive, both)!)).toEqual([]);
  });

  test("a Base plan pays USDC to the Base payments address", async () => {
    const { decodeFunctionData, parseAbi } = await import("viem");
    const sent: { to: Address; data: `0x${string}` }[] = [];
    const w: Eip1193 = {
      request: async (a) => {
        if (a.method === "eth_chainId") return "0x2105";
        if (a.method === "eth_sendTransaction") {
          sent.push(a.params![0] as never);
          return `0x${"ab".repeat(32)}`;
        }
        throw new Error(a.method);
      },
    };
    const n = network({ ...baseLive, key: "base-plan-test" });
    // The receipt read goes to the network, so stub it on this network's own client.
    (n.client as unknown as { waitForTransactionReceipt: () => Promise<{ status: string }> }).waitForTransactionReceipt = async () => ({ status: "success" });
    await n.payPlan({ provider: w, account: A(9), onConfirm: () => {} }, 60_000_000n);
    expect(sent[0]!.to).toBe(base.planToken);
    const { args } = decodeFunctionData({ abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), data: sent[0]!.data });
    expect(args).toEqual([baseLive.planPayTo!, 60_000_000n]);
  });

  test("new copy is clean", () => {
    expect(findBanned(COPY.planPerChain + COPY.network)).toEqual([]);
  });
});
