// The v2 deploy tooling, offline: the plan has no admin batch, the preset registration script refuses mainnet unless told
// otherwise and skips what is registered, and the verifier's removed-function check and domain separator are right.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, toFunctionSelector, type Address, type Hex } from "viem";
import { alarmBookAbi } from "../src/chain/abi";
import { keyOf, Kind, registrationOrder } from "../src/api/presets";
import { contractsBuilt, OUT } from "./forge";
import { planFiles, presetBatch, writePlan, type Deployment, type Settings } from "../deploy/plan";
import { baselineWarnings, parseArgs, readKeyFile, Refused, registerPresets, REGISTER_GAS_FLOOR, type RegisterDeps } from "../deploy/register-presets";
import { ALARM_BOOK_CONSTANTS, domainSeparator, REMOVED_ROUTER_FUNCTIONS, ROUTER_CONSTANTS } from "../deploy/verify";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const D: Deployment = { timelock: A(1), alarmBook: A(2), router: A(3), adapter: A(4), startBlock: 100 };
const VAULTS = [A(0x51), A(0x52)];
const S: Settings = {
  chainId: 4663, proposer: A(5), guardian: A(6), stable: A(7), weth: A(8), swapRouter: A(9), stableFeed: A(10), heartbeat: 90_000,
  adminExpiry: 2_000_000_000, watchers: [A(11), A(12), A(13)], vaults: VAULTS,
};
const tmp = mkdtempSync(join(tmpdir(), "canopy-tools-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("the plan", () => {
  test("has no admin batch: only the alarm registration is left to sign", () => {
    expect(planFiles(D, S).map(([f]) => f)).toEqual(["1-register-alarms.safe.json"]);
    const out = join(tmp, "plan");
    writePlan(D, S, out);
    expect(readdirSync(out).sort()).toEqual(["1-register-alarms.safe.json", "deployment.json", "services.env", "web-mainnet.json"]);
    expect(readFileSync(join(out, "services.env"), "utf8")).toContain(`WATCHERS=${S.watchers.join(",")}`);
  });

  test("a delayed Timelock changes nothing about the files", () => {
    expect(planFiles(D, { ...S, timelockDelay: 3600 }).map(([f]) => f)).toEqual(["1-register-alarms.safe.json"]);
  });

  test("registers six alarms per vault, seven for one that answers paused()", () => {
    expect(presetBatch(D, VAULTS)).toHaveLength(12);
    expect(presetBatch(D, VAULTS, { pausedVaults: [VAULTS[0]!] })).toHaveLength(13);
    for (const c of presetBatch(D, VAULTS)) expect(c.to).toBe(D.alarmBook);
  });
});

/** A chain that knows which keys are registered, and records what was sent. */
function fake(o: { chainId: number; registered?: Set<Hex>; pausedVaults?: Address[]; revertEstimate?: boolean }) {
  const registered = o.registered ?? new Set<Hex>();
  const sent: { to: Address; data: Hex; gas: bigint }[] = [];
  const lines: string[] = [];
  const deps: RegisterDeps = {
    account: A(0xaa),
    log: (l) => lines.push(l),
    client: {
      getChainId: async () => o.chainId,
      estimateGas: async () => {
        if (o.revertEstimate) throw new Error("execution reverted: BadDetector()\nmore");
        return 400_000n;
      },
      waitForTransactionReceipt: async () => ({ status: "success" }),
      readContract: async ({ functionName, args, address }: { functionName: string; args?: unknown[]; address: Address }) => {
        if (functionName === "ADMIN") return A(1);
        if (functionName === "paused") {
          if (o.pausedVaults?.includes(address)) return false;
          throw new Error("no such function");
        }
        if (functionName === "state") return [registered.has(args![0] as Hex), 0n, 0n, 0n, 0n, 0n, 0n];
        throw new Error(functionName);
      },
    } as never,
    send: async (tx) => {
      sent.push(tx);
      const det = decodeFunctionData({ abi: alarmBookAbi, data: tx.data }).args![0] as Parameters<typeof keyOf>[0];
      registered.add(keyOf(det));
      return `0x${sent.length.toString(16).padStart(64, "0")}` as Hex;
    },
  };
  return { deps, sent, lines, registered };
}
const opts = { book: A(2), vaults: VAULTS, mainnet: false, dryRun: false };

describe("register-presets", () => {
  test("registers every preset of every vault, with enough gas for the target reads, printing each transaction", async () => {
    const f = fake({ chainId: 84532 });
    const r = await registerPresets(f.deps, opts);
    expect(r).toEqual({ registered: 12, skipped: 0, wouldSend: 0 });
    expect(f.sent).toHaveLength(12);
    expect(f.sent.every((t) => t.to === A(2) && t.gas >= REGISTER_GAS_FLOOR)).toBe(true);
    expect(f.lines.filter((l) => l.includes("tx 0x"))).toHaveLength(12);
  });

  test("skips what is registered, so a second run sends nothing", async () => {
    const f = fake({ chainId: 84532 });
    await registerPresets(f.deps, opts);
    const again = fake({ chainId: 84532, registered: f.registered });
    expect(await registerPresets(again.deps, opts)).toEqual({ registered: 0, skipped: 12, wouldSend: 0 });
    expect(again.sent).toHaveLength(0);
  });

  test("resumes after a partial run", async () => {
    const some = new Set(registrationOrder(VAULTS[0]!).slice(0, 4).map(keyOf));
    const f = fake({ chainId: 84532, registered: some });
    expect(await registerPresets(f.deps, opts)).toMatchObject({ registered: 8, skipped: 4 });
  });

  test("a vault that answers paused() also gets the Paused alarm", async () => {
    const f = fake({ chainId: 84532, pausedVaults: [VAULTS[1]!] });
    expect((await registerPresets(f.deps, opts)).registered).toBe(13);
  });

  test("a dry run sends nothing", async () => {
    const f = fake({ chainId: 84532 });
    expect(await registerPresets(f.deps, { ...opts, dryRun: true })).toEqual({ registered: 0, skipped: 0, wouldSend: 12 });
    expect(f.sent).toHaveLength(0);
  });

  test("refuses Robinhood Chain mainnet unless --mainnet is given, and sends nothing", async () => {
    const f = fake({ chainId: 4663 });
    await expect(registerPresets(f.deps, opts)).rejects.toThrow(/mainnet/);
    await expect(registerPresets(f.deps, { ...opts, dryRun: true })).rejects.toBeInstanceOf(Refused);
    expect(f.sent).toHaveLength(0);
    expect((await registerPresets(f.deps, { ...opts, mainnet: true })).registered).toBe(12);
  });

  test("refuses Base mainnet the same way", async () => {
    await expect(registerPresets(fake({ chainId: 8453 }).deps, opts)).rejects.toThrow(/mainnet/);
  });

  test("stops with the reason when a registration would be refused, and does not send it", async () => {
    const f = fake({ chainId: 84532, revertEstimate: true });
    await expect(registerPresets(f.deps, opts)).rejects.toThrow(/would be refused: execution reverted: BadDetector\(\)/);
    expect(f.sent).toHaveLength(0);
  });

  test("refuses an address that is not an AlarmBook", async () => {
    const f = fake({ chainId: 84532 });
    (f.deps.client as unknown as { readContract: unknown }).readContract = async () => { throw new Error("no code"); };
    await expect(registerPresets(f.deps, opts)).rejects.toThrow(/does not answer like an AlarmBook/);
  });

  test("the key file must be private and hold one key, and the key is never in an error", () => {
    const key = `0x${"ab".repeat(32)}`;
    const file = join(tmp, "key");
    writeFileSync(file, `${key}\n`, { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(() => readKeyFile(file)).toThrow(/readable by other users/);
    chmodSync(file, 0o600);
    expect(readKeyFile(file)).toBe(key as Hex);
    writeFileSync(file, `${"ab".repeat(32)}`);
    expect(readKeyFile(file)).toBe(key as Hex);
    writeFileSync(file, "not a key");
    try { readKeyFile(file); } catch (e) { expect((e as Error).message).not.toContain("not a key"); }
    expect(() => readKeyFile(file)).toThrow(/64 hex/);
  });

  test("flags", () => {
    expect(parseArgs(["--rpc", "http://x", "--mainnet", "--dry-run"])).toEqual({ values: { rpc: "http://x" }, flags: new Set(["mainnet", "dry-run"]) });
    expect(() => parseArgs(["--rpc"])).toThrow(/needs a value/);
    expect(() => parseArgs(["stray"])).toThrow(/unexpected/);
  });
});

// The compiled router is needed for the first test only. Without contracts/out it is built (forge), or the test says why it was skipped.
const build = contractsBuilt();

describe("the verifier's fixed facts", () => {
  test.skipIf(!build.ok)("the removed router functions are not in the compiled router, and a function that is there is found", () => {
    const router = JSON.parse(readFileSync(join(OUT, "ExitRouter.sol/ExitRouter.json"), "utf8")) as { deployedBytecode: { object: string } };
    const code = router.deployedBytecode.object.toLowerCase();
    for (const sig of REMOVED_ROUTER_FUNCTIONS) expect(code.includes(toFunctionSelector(sig).slice(2).toLowerCase())).toBe(false);
    expect(code.includes(toFunctionSelector("swapsOf(bytes32)").slice(2).toLowerCase())).toBe(true);
  });

  test("the domain separator is version 2 and depends on the chain and the contract", () => {
    const a = domainSeparator(4663, A(2));
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(domainSeparator(8453, A(2))).not.toBe(a);
    expect(domainSeparator(4663, A(3))).not.toBe(a);
  });

  test("the constants written down are the ones the contracts were built with", () => {
    const src = (f: string) => readFileSync(join(import.meta.dir, "../../contracts/src", f), "utf8");
    const value = (text: string, name: string) => {
      const m = new RegExp(`constant ${name} = ([^;]+);`).exec(text);
      if (!m) throw new Error(`no constant ${name}`);
      const e = m[1]!.replace(/(\d)_(?=\d)/g, "$1").trim();
      const days = /^(\d+) days$/.exec(e);
      if (days) return BigInt(days[1]!) * 86_400n;
      const hours = /^(\d+) hours$/.exec(e);
      if (hours) return BigInt(hours[1]!) * 3_600n;
      if (/^\d+$/.test(e)) return BigInt(e);
      const quote = /^4 \* FEED_READ_GAS \+ (\d+)$/.exec(e);
      if (quote) return 400_000n + BigInt(quote[1]!);
      throw new Error(`cannot read ${name} = ${e}`);
    };
    for (const [n, want] of Object.entries(ALARM_BOOK_CONSTANTS)) expect([n, value(src("AlarmBook.sol"), n)]).toEqual([n, want]);
    for (const [n, want] of Object.entries(ROUTER_CONSTANTS)) expect([n, value(src("ExitRouter.sol"), n)]).toEqual([n, want]);
  });
});

describe("register-presets warns about a baseline someone else registered", () => {
  const TARGET = A(0x77);
  const clientOf = (reads: Record<string, unknown>, current?: Hex) => ({
    client: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName in reads) return reads[functionName];
        throw new Error(functionName);
      },
      ...(current ? { call: async () => ({ data: current }) } : {}),
    },
  }) as never;
  const det = (kind: number, a: Hex = `0x${"00".repeat(32)}`) => ({ kind, target: TARGET, threshold: 50n, window: 0, a, b: a });

  test("a SHARE_DROP baseline more than half a percent above the share price", async () => {
    const c = clientOf({ decimals: 18, convertToAssets: 1_000_000n });
    expect(await baselineWarnings(c, det(Kind.SHARE_DROP), 1_006_000n)).toHaveLength(1);
    expect(await baselineWarnings(c, det(Kind.SHARE_DROP), 1_005_000n)).toEqual([]); // exactly 0.5% is tolerated
    expect(await baselineWarnings(c, det(Kind.SHARE_DROP), 900_000n)).toEqual([]); // below the price is the safe side
  });

  test("an ADDRESS_CHANGE baseline that is not the current address", async () => {
    const now = `0x${"00".repeat(12)}${"ab".repeat(20)}` as Hex;
    const c = clientOf({}, now);
    expect(await baselineWarnings(c, det(Kind.ADDRESS_CHANGE, `0x313ce567${"00".repeat(28)}`), BigInt(`0x${"cd".repeat(20)}`))).toHaveLength(1);
    expect(await baselineWarnings(c, det(Kind.ADDRESS_CHANGE, `0x313ce567${"00".repeat(28)}`), BigInt(`0x${"ab".repeat(20)}`))).toEqual([]);
  });

  test("a DRAIN reference of zero", async () => {
    expect(await baselineWarnings(clientOf({}), det(Kind.DRAIN), 0n)).toHaveLength(1);
    expect(await baselineWarnings(clientOf({}), det(Kind.DRAIN), 5n)).toEqual([]);
  });

  test("a target that can't be read says nothing and doesn't stop the run", async () => {
    expect(await baselineWarnings(clientOf({}), det(Kind.SHARE_DROP), 10n ** 30n)).toEqual([]);
  });

  test("the run prints the warning loudly for a key already registered, still skips it, and does not fail", async () => {
    const f = fake({ chainId: 84532, registered: new Set(registrationOrder(VAULTS[0]!, VAULTS[0]!).map(keyOf)) });
    const base = f.deps.client.readContract as unknown as (a: { functionName: string; args?: unknown[]; address: Address }) => Promise<unknown>;
    // The DRAIN alarms read as registered with a zero reference (the fake's default state); the vault's share price is unreadable.
    (f.deps.client as unknown as { readContract: unknown }).readContract = base;
    const res = await registerPresets(f.deps, { ...opts, vaults: [VAULTS[0]!] });
    expect(res.registered).toBe(0);
    expect(f.sent).toHaveLength(0);
    expect(f.lines.some((l) => l.includes("WARNING") && l.includes("DRAIN"))).toBe(true);
  });
});
