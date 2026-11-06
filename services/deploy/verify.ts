/**
 * Independent check of a live deployment against the tested build and the intended settings.
 * Values are compared to deployment.json and to constants written out here, never read back from the contracts being checked.
 * v2 has no setup step after the deploy, so there is one stage: everything must hold straight after the deploy script ran.
 * Usage: bun deploy/verify.ts <deployment.json> <rpc url>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeAbiParameters, getAbiItem, http, keccak256, parseAbi, stringToHex, toFunctionSelector, type Address, type PublicClient } from "viem";
import { alarmBookAbi, routerAbi } from "../src/chain/abi";
import { delayOf, MAINNETS, type Deployment, type Settings } from "./plan";

const OUT = join(import.meta.dir, "../../contracts/out");
const timelockAbi = parseAbi(["function PROPOSER() view returns (address)", "function DELAY() view returns (uint256)"]);
const adapterAbi = parseAbi(["function ROUTER() view returns (address)"]);

const DAY = 86_400n;
/** AlarmBook constants the launch is built on, written out here so a changed contract is caught even if its tests were edited too. */
export const ALARM_BOOK_CONSTANTS = {
  TARGET_READ_GAS: 1_000_000n,
  MIN_DRAIN_WINDOW: 1_200n,
  DRAIN_CONFIRM: 60n,
  REFIRE_AFTER: DAY,
  REBASE_AFTER: 7n * DAY,
  WATCHER_DELAY: 2n * DAY,
  MAX_WATCHER_TERM: 365n * DAY,
  MAX_ATTEST_LIFE: 3_600n,
  MAX_QUORUM: 32n,
} as const;
/** The router's. */
export const ROUTER_CONSTANTS = {
  MAX_KEYS: 8n,
  MAX_SWAPS: 4n,
  MAX_SLIP_CAP_BPS: 1_000n,
  THIRD_PARTY_SLIP_CAP_BPS: 100n,
  ALARM_TTL: DAY,
  MAX_FEED_HEARTBEAT: 2n * DAY,
  STABLE_FLOOR_BPS: 9_850n,
  FEED_READ_GAS: 100_000n,
  QUOTE_GAS: 500_000n,
  MAX_TOKEN_DECIMALS: 36n,
} as const;
/** Functions v2 removed. None may be in the router: the owner names every swap leg, and the admin has no swap settings. */
export const REMOVED_ROUTER_FUNCTIONS = ["setFeed(address,address,uint32,uint8)", "setRoute(address,bytes)", "feeds(address)", "routes(address)", "swapConfig()"] as const;
/** The EIP-712 domain version of the AlarmBook. The watchers sign under it. */
export const DOMAIN_VERSION = "2";

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

/** The domain separator AlarmBook computes in its constructor, for a chain and an address. */
export const domainSeparator = (chainId: number, book: Address) =>
  keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [
      keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
      keccak256(stringToHex("Canopy AlarmBook")),
      keccak256(stringToHex(DOMAIN_VERSION)),
      BigInt(chainId),
      book,
    ],
  ));

export async function verifyDeployment(client: PublicClient, d: Deployment, s: Settings): Promise<Check[]> {
  const out: Check[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const eq = (name: string, got: unknown, want: unknown) => {
    const ok = typeof got === "string" && typeof want === "string" ? same(got, want) : String(got) === String(want);
    out.push({ name, ok, detail: ok ? undefined : `got ${got}, wanted ${want}` });
  };
  const codes: Record<string, string> = {};
  for (const [name, address, file] of [
    ["Timelock", d.timelock, s.testTimelockDelay ? "TestAssets.sol/TestTimelock.json" : "Timelock.sol/Timelock.json"],
    ["AlarmBook", d.alarmBook, "AlarmBook.sol/AlarmBook.json"],
    ["ExitRouter", d.router, "ExitRouter.sol/ExitRouter.json"],
    ["ERC4626Adapter", d.adapter, "ERC4626Adapter.sol/ERC4626Adapter.json"],
  ] as const) {
    const live = (await client.getCode({ address })) ?? "0x";
    codes[name] = live;
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

  // The router allows the adapter from its constructor, and nothing else.
  eq("Adapter is allowed from deployment", await read(d.router, r, "adapterAllowed", [d.adapter]), true);
  const adapterEvents = await client.getLogs({ address: d.router, event: getAbiItem({ abi: routerAbi, name: "AdapterSet" }), fromBlock: BigInt(d.startBlock), toBlock: "latest" }).catch(() => null);
  if (adapterEvents === null) out.push({ name: "Router adapter list could be read", ok: false, detail: "getLogs failed" });
  else {
    const allowed = new Map<string, boolean>();
    for (const e of adapterEvents) allowed.set(e.args.adapter!.toLowerCase(), e.args.allowed!);
    const on = [...allowed].filter(([, v]) => v).map(([k]) => k);
    out.push({ name: "The adapter is the only allowed adapter", ok: on.length === 1 && on[0] === d.adapter.toLowerCase(), detail: on.length === 1 && on[0] === d.adapter.toLowerCase() ? undefined : `allowed: ${on.join(", ") || "none"}` });
  }

  // Watchers: active from the deploy for exactly one term, and nobody else.
  const startTime = (await client.getBlock({ blockNumber: BigInt(d.startBlock) })).timestamp;
  const now = (await client.getBlock()).timestamp;
  const term = ALARM_BOOK_CONSTANTS.MAX_WATCHER_TERM;
  const sinces: bigint[] = [];
  for (const w of s.watchers) {
    const label = `Watcher ${w.slice(0, 8)}`;
    eq(`${label} is active`, await read(d.alarmBook, b, "isWatcher", [w]), true);
    const since = await read<bigint>(d.alarmBook, b, "watcherSince", [w]);
    const until = await read<bigint>(d.alarmBook, b, "watcherUntil", [w]);
    sinces.push(since);
    out.push({ name: `${label} started at the deploy`, ok: since >= startTime && since <= now, detail: `since ${since}, deploy block time ${startTime}` });
    eq(`${label} is approved for 365 days`, until - since, term);
  }
  out.push({ name: "Every watcher started in the same transaction", ok: sinces.every((x) => x === sinces[0]), detail: sinces.join(", ") });
  const watcherEvents = await client.getLogs({ address: d.alarmBook, event: getAbiItem({ abi: alarmBookAbi, name: "WatcherSet" }), fromBlock: BigInt(d.startBlock), toBlock: "latest" }).catch(() => null);
  if (watcherEvents === null) out.push({ name: "AlarmBook watcher list could be read", ok: false, detail: "getLogs failed" });
  else {
    const current = new Map<string, bigint>();
    for (const e of watcherEvents) current.set(e.args.watcher!.toLowerCase(), e.args.until!);
    const extra = [...current].filter(([w, until]) => until !== 0n && !s.watchers.some((x) => x.toLowerCase() === w)).map(([w]) => w);
    out.push({ name: "No watcher beyond the intended ones", ok: extra.length === 0, detail: extra.join(", ") });
  }

  // Signing domain, and the constants the launch settings rest on.
  eq("AlarmBook signing domain is version 2 on this chain", await read(d.alarmBook, b, "DOMAIN_SEPARATOR"), domainSeparator(s.chainId, d.alarmBook));
  for (const [name, want] of Object.entries(ALARM_BOOK_CONSTANTS)) eq(`AlarmBook ${name}`, await read(d.alarmBook, b, name), want);
  for (const [name, want] of Object.entries(ROUTER_CONSTANTS)) eq(`Router ${name}`, await read(d.router, r, name), want);

  // The owner names every swap leg. Neither the admin nor anyone else can set a feed or route on the router.
  const routerCode = codes.ExitRouter!.toLowerCase();
  for (const sig of REMOVED_ROUTER_FUNCTIONS) {
    out.push({ name: `Router has no ${sig.split("(")[0]}`, ok: !routerCode.includes(toFunctionSelector(sig).slice(2).toLowerCase()) });
  }
  return out;
}

if (import.meta.main) {
  const [file, rpc] = process.argv.slice(2);
  if (!file || !rpc) throw new Error("usage: bun deploy/verify.ts <deployment.json> <rpc url>");
  const { settings, ...d } = JSON.parse(readFileSync(file, "utf8")) as Deployment & { settings: Settings };
  const client = createPublicClient({ transport: http(rpc) }) as PublicClient;
  const checks = await verifyDeployment(client, d, settings);
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `${failed} checks FAILED. Do not launch.` : `all ${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
