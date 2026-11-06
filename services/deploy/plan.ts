/**
 * Turns a broadcast deployment into the files the launch needs. Holds no keys and sends nothing.
 * Usage: bun deploy/plan.ts <run-latest.json> <settings.json> <out dir>
 *
 * v2 needs no admin setup: the router allows the vault adapter in its constructor and the AlarmBook approves the watchers in
 * its own, so the deploy leaves nothing for the Timelock to do. What remains is registering the launch vaults' alarm
 * presets, which anyone can do (see deploy/register-presets.ts), and the service and web settings.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { alarmBookAbi } from "../src/chain/abi";
import { registrationOrder } from "../src/api/presets";

export interface Settings {
  chainId: number;
  proposer: Address;
  guardian: Address;
  stable: Address;
  weth: Address;
  swapRouter: Address;
  stableFeed: Address;
  heartbeat: number;
  adminExpiry: number;
  /** Approved from deployment for 365 days (the deploy's WATCHERS). */
  watchers: Address[];
  vaults: Address[];
  /** Launch vaults that answer paused(). They get the Paused alarm too. None of the five launch vaults does. */
  pausedVaults?: Address[];
  /** The app's plan payment Safe and API address, for the web config. */
  planPayTo?: Address;
  apiUrl?: string;
  /** Testnet only: admins may be plain wallets. Refused on mainnet. */
  allowEoaAdmin?: boolean;
  /** Seconds each admin change waits in the Timelock. 0 (the default) applies a change as soon as the multisig signs. */
  timelockDelay?: number;
  /** Testnet only: deploys a TestTimelock with this delay. Refused on mainnet. */
  testTimelockDelay?: number;
}
export interface Deployment { timelock: Address; alarmBook: Address; router: Address; adapter: Address; startBlock: number }
export interface Call { to: Address; value: string; data: Hex }

export function readBroadcast(path: string): Deployment {
  const run = JSON.parse(readFileSync(path, "utf8")) as {
    transactions: { transactionType: string; contractName: string; contractAddress: Address }[];
    receipts: { blockNumber: string }[];
  };
  const find = (name: string) => {
    const hits = run.transactions.filter((t) => t.transactionType === "CREATE" && t.contractName === name);
    if (hits.length !== 1) throw new Error(`expected one ${name}, found ${hits.length}`);
    return hits[0]!.contractAddress;
  };
  return {
    timelock: find("Timelock"), alarmBook: find("AlarmBook"), router: find("ExitRouter"), adapter: find("ERC4626Adapter"),
    startBlock: Number(run.receipts[0]!.blockNumber),
  };
}

export const delayOf = (s: Settings) => s.testTimelockDelay ?? s.timelockDelay ?? 0;
export const MAINNETS = [8453, 4663];

/** Whether a launch vault is to get the Paused alarm. */
const answersPaused = (s: Pick<Settings, "pausedVaults">, v: Address) => (s.pausedVaults ?? []).some((p) => p.toLowerCase() === v.toLowerCase());

/** AlarmBook registration is open to anyone, so this batch needs no Timelock. */
export function presetBatch(d: Deployment, vaults: Address[], s: Pick<Settings, "pausedVaults"> = {}): Call[] {
  return vaults.flatMap((v) =>
    registrationOrder(v, v, { paused: answersPaused(s, v) }).map((x) => ({
      to: d.alarmBook,
      value: "0",
      data: encodeFunctionData({ abi: alarmBookAbi, functionName: "register", args: [x] }),
    })),
  );
}

/** Safe Transaction Builder format. */
const safeBatch = (chainId: number, name: string, description: string, transactions: Call[]) => ({
  version: "1.0",
  chainId: String(chainId),
  meta: { name, description },
  transactions,
});

/** The Safe batch files. Just one: registering the alarm presets. There is no admin setup to sign. */
export function planFiles(d: Deployment, s: Settings): [string, ReturnType<typeof safeBatch>][] {
  return [["1-register-alarms.safe.json", safeBatch(s.chainId, "Canopy: register alarm presets", `${s.vaults.length} vaults`, presetBatch(d, s.vaults, s))]];
}

export function writePlan(d: Deployment, s: Settings, out: string) {
  mkdirSync(out, { recursive: true });
  const write = (f: string, v: unknown) => writeFileSync(join(out, f), `${JSON.stringify(v, null, 2)}\n`);
  write("deployment.json", { ...d, settings: s });
  for (const [file, batch] of planFiles(d, s)) write(file, batch);
  writeFileSync(join(out, "services.env"), [
    `CHAIN_ID=${s.chainId}`, `ROUTER=${d.router}`, `ALARM_BOOK=${d.alarmBook}`, `ADAPTER_4626=${d.adapter}`, `START_BLOCK=${d.startBlock}`,
    `PLAN_TOKEN=${s.stable}`, `WATCHERS=${s.watchers.join(",")}`,
    // Railway sends X-Forwarded-For as "caller, edge" (measured), so two entries at the end are the proxies' own. With the
    // default of 1 every caller would share the edge server's address and one rate-limit bucket.
    `# Railway sends "caller, edge" in X-Forwarded-For (measured): two hops.`,
    "TRUSTED_PROXY_HOPS=2",
    "RATE_LIMIT_PER_MIN=120", "",
  ].join("\n"));
  write("web-mainnet.json", { router: d.router, adapter: d.adapter, alarmBook: d.alarmBook, planPayTo: s.planPayTo ?? null, apiUrl: s.apiUrl ?? "" });
}

if (import.meta.main) {
  const [run, settings, out] = process.argv.slice(2);
  if (!run || !settings || !out) throw new Error("usage: bun deploy/plan.ts <run-latest.json> <settings.json> <out dir>");
  writePlan(readBroadcast(run), JSON.parse(readFileSync(settings, "utf8")) as Settings, out);
  console.log(`wrote plan to ${out}`);
}
