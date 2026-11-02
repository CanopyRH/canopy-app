/**
 * Independent check of a live deployment against the tested build and the intended settings.
 * Values are compared to deployment.json, never read back from the contracts being checked.
 * Usage: bun deploy/verify.ts <deployment.json> <rpc url> <deployed|live>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { alarmBookAbi, routerAbi } from "../src/chain/abi";
import { delayOf, MAINNETS, type Deployment, type Settings } from "./plan";

const OUT = join(import.meta.dir, "../../contracts/out");
const timelockAbi = parseAbi(["function PROPOSER() view returns (address)", "function DELAY() view returns (uint256)"]);
const adapterAbi = parseAbi(["function ROUTER() view returns (address)"]);

export interface Check { name: string; ok: boolean; detail?: string }

/** Runtime code with immutable slots blanked, since those hold deployment-specific values checked separately. */
function masked(code: string, refs: Record<string, { start: number; length: number }[]>): string {
  const chars = code.replace(/^0x/, "").split("");
  for (const list of Object.values(refs)) {
    for (const { start, length } of list) chars.fill("0", start * 2, (start + length) * 2);
  }
  return chars.join("");
}

function artifact(file: string) {
  const a = JSON.parse(readFileSync(join(OUT, file), "utf8"));
  return { code: a.deployedBytecode.object as string, refs: (a.deployedBytecode.immutableReferences ?? {}) as Record<string, { start: number; length: number }[]> };
}

export async function verifyDeployment(client: PublicClient, d: Deployment, s: Settings, stage: "deployed" | "live"): Promise<Check[]> {
  const out: Check[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const eq = (name: string, got: unknown, want: unknown) => {
    const ok = typeof got === "string" && typeof want === "string" ? same(got, want) : String(got) === String(want);
    out.push({ name, ok, detail: ok ? undefined : `got ${got}, wanted ${want}` });
  };
  for (const [name, address, file] of [
    ["Timelock", d.timelock, s.testTimelockDelay ? "TestAssets.sol/TestTimelock.json" : "Timelock.sol/Timelock.json"],
    ["AlarmBook", d.alarmBook, "AlarmBook.sol/AlarmBook.json"],
    ["ExitRouter", d.router, "ExitRouter.sol/ExitRouter.json"],
    ["ERC4626Adapter", d.adapter, "ERC4626Adapter.sol/ERC4626Adapter.json"],
  ] as const) {
    const live = (await client.getCode({ address })) ?? "0x";
    const a = artifact(file);
    out.push({ name: `${name} bytecode matches the tested build`, ok: masked(live, a.refs) === masked(a.code, a.refs) });
  }
  const read = <T>(address: Address, abi: never, functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const t = timelockAbi as never, r = routerAbi as never, b = alarmBookAbi as never, a = adapterAbi as never;

  eq("Timelock proposer", await read(d.timelock, t, "PROPOSER"), s.proposer);
  eq(s.testTimelockDelay ? "Test Timelock delay" : `Timelock delay is ${delayOf(s)}s`, await read(d.timelock, t, "DELAY"), BigInt(delayOf(s)));
  eq("AlarmBook admin is the Timelock", await read(d.alarmBook, b, "ADMIN"), d.timelock);
  eq("Router admin is the Timelock", await read(d.router, r, "ADMIN"), d.timelock);
  eq("Router alarm book", await read(d.router, r, "ALARMS"), d.alarmBook);
  eq("Router guardian", await read(d.router, r, "guardian"), s.guardian);
  eq("Router stablecoin", await read(d.router, r, "STABLE"), s.stable);
  eq("Router WETH", await read(d.router, r, "WETH"), s.weth);
  eq("Router swap router", await read(d.router, r, "SWAP_ROUTER"), s.swapRouter);
  eq("Router stablecoin feed", await read(d.router, r, "STABLE_FEED"), s.stableFeed);
  eq("Router feed heartbeat", await read(d.router, r, "STABLE_FEED_HEARTBEAT"), s.heartbeat);
  eq("Router admin expiry", await read(d.router, r, "ADMIN_EXPIRY"), s.adminExpiry);
  eq("Arming is not paused", await read(d.router, r, "armingPaused"), false);
  eq("Adapter is wired to this router", await read(d.adapter, a, "ROUTER"), d.router);
  const mainnet = MAINNETS.includes(s.chainId);
  if (s.allowEoaAdmin && mainnet) out.push({ name: "Plain-wallet admins are refused on mainnet", ok: false });
  if (s.testTimelockDelay && mainnet) out.push({ name: "The test Timelock is refused on mainnet", ok: false });
  if (!s.allowEoaAdmin || mainnet) {
    eq("Multisig proposer is a contract", ((await client.getCode({ address: s.proposer })) ?? "0x").length > 2, true);
    eq("Multisig guardian is a contract", ((await client.getCode({ address: s.guardian })) ?? "0x").length > 2, true);
  }
  eq(`Adapter is ${stage === "live" ? "enabled" : "still disabled"}`, await read(d.router, r, "adapterAllowed", [d.adapter]), stage === "live");
  for (const w of s.watchers) {
    eq(`Watcher ${w.slice(0, 8)} is ${stage === "live" ? "approved" : "not yet approved"}`, await read(d.alarmBook, b, "isWatcher", [w]), stage === "live");
  }
  // Swap stays off in v1, so no route may exist.
  eq("No swap route on WETH", await read<Hex>(d.router, r, "routes", [s.weth]), "0x");
  return out;
}

if (import.meta.main) {
  const [file, rpc, stage] = process.argv.slice(2);
  if (!file || !rpc || (stage !== "deployed" && stage !== "live")) throw new Error("usage: bun deploy/verify.ts <deployment.json> <rpc url> <deployed|live>");
  const { settings, ...d } = JSON.parse(readFileSync(file, "utf8")) as Deployment & { settings: Settings };
  const client = createPublicClient({ transport: http(rpc) }) as PublicClient;
  const checks = await verifyDeployment(client, d, settings, stage);
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `${failed} checks FAILED. Do not launch.` : `all ${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
