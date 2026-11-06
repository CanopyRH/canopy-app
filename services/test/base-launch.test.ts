// The Base launch tooling, offline: the vault check, the per-chain file and vault choices, the web config writer, and that a
// Base services env from plan.ts loads with Base's confirmations and lag limits.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toFunctionSelector, type Address } from "viem";
import { BASE, chainParts } from "../src/chain/addresses";
import { loadEnv } from "../src/env";
import { checkVault, EXIT_GATES } from "../deploy/check-vaults";
import { writePlan, type Deployment, type Settings } from "../deploy/plan";
import { launchFiles } from "../deploy/preflight";
import { defaultVaults, Refused } from "../deploy/register-presets";
import { isLocalNode, webBaseConfig } from "../deploy/web-base-config";
import { CHAINS } from "../../web/src/config";
import { ROOT } from "./forge";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const ZERO = A(0);
const example = JSON.parse(readFileSync(join(ROOT, "deploy/settings.base.example.json"), "utf8")) as Settings & { adminExpiry: number };
const tmp = mkdtempSync(join(tmpdir(), "canopy-base-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A vault that answers like Morpho's: V1 has no gate functions, V2 has three gates and abdication. */
function vault(o: { v2?: boolean; asset?: Address; total?: bigint; price?: bigint | null; gate?: Address; notAbdicated?: string; paused?: boolean }) {
  const abdicatedOff = o.notAbdicated ? toFunctionSelector(`function ${EXIT_GATES.find(([g]) => g === o.notAbdicated)![1]}`) : null;
  return {
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      switch (functionName) {
        case "asset": return o.asset ?? BASE.usdc;
        case "name": return "Test USDC";
        case "decimals": return 18;
        case "totalAssets": return o.total ?? 1_000_000n;
        case "convertToAssets": if (o.price === null) throw new Error("revert"); return o.price ?? 1_050_000n;
        case "paused": if (o.paused) return false; throw new Error("no paused()");
        case "adaptersLength": if (o.v2) return 1n; throw new Error("not v2");
        case "abdicated": return args![0] !== abdicatedOff;
        case "sendSharesGate": case "receiveSharesGate": case "receiveAssetsGate":
          return functionName === "receiveSharesGate" && o.gate ? o.gate : ZERO;
      }
      throw new Error(functionName);
    },
  } as never;
}

describe("check-vaults", () => {
  test("a Vault V1 holding USDC passes, and so does a V2 with every exit gate unset and abdicated", async () => {
    expect((await checkVault(vault({}), A(1), BASE.usdc)).ok).toBe(true);
    const v2 = await checkVault(vault({ v2: true }), A(1), BASE.usdc);
    expect(v2).toMatchObject({ ok: true, version: "v2", answersPaused: false, sharePrice: 1_050_000n });
  });

  test("each reason to drop a vault is caught, and said in plain words", async () => {
    const fail = async (o: Parameters<typeof vault>[0]) => (await checkVault(vault(o), A(1), BASE.usdc)).problems;
    expect(await fail({ asset: A(9) })).toEqual([`asset is ${A(9)}, not the stablecoin`]);
    expect(await fail({ total: 0n })).toEqual(["totalAssets is zero"]);
    expect(await fail({ price: null })).toEqual(["the share price can't be read"]);
    expect(await fail({ v2: true, gate: A(7) })).toEqual([`receiveSharesGate is set to ${A(7)}`]);
    expect(await fail({ v2: true, notAbdicated: "sendSharesGate" })).toEqual(["sendSharesGate is not abdicated, so the curator can still turn it on"]);
  });

  test("a vault that answers paused() is reported for pausedVaults", async () => {
    expect((await checkVault(vault({ paused: true }), A(1), BASE.usdc)).answersPaused).toBe(true);
  });
});

describe("Base files and vaults", () => {
  test("Base reads its own settings and deploy env, Robinhood Chain keeps the old names", () => {
    expect(launchFiles(8453)).toEqual({ settings: "settings.base.json", settingsExample: "settings.base.example.json", deployEnv: "launch.base.env", deployEnvExample: "launch.base.env.example" });
    expect(launchFiles(4663)).toEqual({ settings: "settings.json", settingsExample: "settings.example.json", deployEnv: "launch.env", deployEnvExample: "launch.env.example" });
  });

  test("the Base example settings and deploy env agree, and match the web app's Base network", () => {
    const env = Object.fromEntries(readFileSync(join(ROOT, "deploy/launch.base.env.example"), "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => l.split("=") as [string, string]));
    const web = CHAINS.find((c) => c.chainId === 8453)!;
    expect(example.chainId).toBe(8453);
    expect([env.STABLE, env.WETH, env.SWAP_ROUTER, env.STABLE_FEED]).toEqual([example.stable, example.weth, example.swapRouter, example.stableFeed]);
    expect([example.stable, example.weth, example.swapRouter, example.stableFeed]).toEqual([BASE.usdc, BASE.weth, BASE.swapRouter, BASE.usdcFeed]);
    expect(Number(env.STABLE_FEED_HEARTBEAT)).toBe(example.heartbeat);
    expect(Number(env.ADMIN_EXPIRY)).toBe(example.adminExpiry);
    expect(example.stable).toBe(web.planToken);
    expect(example.vaults).toEqual(web.vaults.map((v) => v.address));
  });

  test("register-presets takes the deployment's vaults, or the web app's for that chain, never another chain's", () => {
    expect(defaultVaults(8453, { settings: { chainId: 8453, vaults: [A(1)] } })).toEqual([A(1)]);
    expect(() => defaultVaults(4663, { settings: { chainId: 8453, vaults: [A(1)] } })).toThrow(Refused);
    expect(defaultVaults(8453)).toEqual(example.vaults);
    expect(defaultVaults(8453)).not.toEqual(defaultVaults(4663));
    expect(() => defaultVaults(1)).toThrow(/Pass --vaults/);
  });

  test("a Base services env from plan.ts loads, with Base's confirmations and lag limit", () => {
    const d: Deployment = { timelock: A(1), alarmBook: A(2), router: A(3), adapter: A(4), startBlock: 100 };
    writePlan(d, { ...example, proposer: A(5), guardian: A(6), watchers: [A(11), A(12), A(13)] }, tmp);
    const planned = Object.fromEntries(readFileSync(join(tmp, "services.env"), "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => l.split("=") as [string, string]));
    const env = loadEnv({
      ...planned, PUBLIC_URL: "https://api-base.example.org", DATABASE_URL: "postgres://x", RPC_URL: "https://a.example.org", RPC_URL_BACKUP: "https://b.example.org",
      PLAN_PAY_ADDRESS: A(9), TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_WEBHOOK_SECRET: "x".repeat(16),
    });
    expect(env.CHAIN_ID).toBe(8453);
    expect(env.PLAN_TOKEN).toBe(BASE.usdc);
    expect(env.CARD_VAULTS.split(",")).toEqual(example.vaults);
    expect(planned.PLAN_PAY_ADDRESS).toBe(example.planPayTo!);
    expect(env.CONFIRMATIONS).toBeUndefined();
    expect(chainParts(env.CHAIN_ID)).toEqual({ morpho: BASE.morpho, multicall3: BASE.multicall3, maxLagBlocks: 20n, confirmations: 5n });
  });
});

describe("web-base-config", () => {
  const d = { timelock: A(1), alarmBook: A(2), router: A(3), adapter: A(4), startBlock: 1 };
  const s = { ...example, planPayTo: A(8), apiUrl: "https://api-base.canopy.invalid/" } as Settings;

  test("builds the Base web file from a Base deployment, keeping the WalletConnect project", () => {
    expect(webBaseConfig({ ...d, settings: s }, { walletConnectProjectId: null })).toEqual({
      config: { router: A(3), adapter: A(4), alarmBook: A(2), deployBlock: 1, planPayTo: A(8), apiUrl: "https://api-base.canopy.invalid", walletConnectProjectId: null },
    });
  });

  test("refuses another chain, a missing payments Safe and the example's placeholders", () => {
    const problems = (x: Partial<Settings>) => {
      const r = webBaseConfig({ ...d, settings: { ...s, ...x } }, {});
      return "problems" in r ? r.problems.join(" | ") : "";
    };
    expect(problems({ chainId: 4663 })).toContain("not Base");
    expect(problems({ planPayTo: example.planPayTo })).toContain("planPayTo");
    expect(problems({ apiUrl: example.apiUrl })).toContain("apiUrl");
    expect(problems({ apiUrl: "http://api.example.org" })).toContain("apiUrl");
    // The limits page reads admin events from the deploy block, so a record without one can't fill the web file.
    const noBlock = webBaseConfig({ ...d, startBlock: 0, settings: s }, {});
    expect("problems" in noBlock ? noBlock.problems.join(" | ") : "").toContain("startBlock");
  });

  test("tells a local fork from Base", () => {
    expect(isLocalNode("anvil/v1.8.6")).toBe(true);
    expect(isLocalNode("reth/v1.9.0-abc/x86_64-unknown-linux-gnu")).toBe(false);
  });
});
