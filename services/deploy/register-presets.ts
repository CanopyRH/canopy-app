/**
 * Registers every launch vault's alarm presets on an AlarmBook. Registration is open to anyone, so any funded key will do: it
 * needs gas and nothing else, and it holds no rights. Alarms already registered are skipped, so a run can be repeated or
 * resumed after a failure. Each transaction is printed as it lands.
 *
 * Usage: bun deploy/register-presets.ts --rpc <url> --key-file <file> (--book <address> | --deployment <deployment.json>)
 *          [--vaults <a,b,...>] [--dry-run] [--mainnet]
 *
 * --key-file holds one private key in hex, and nothing else. It must not be readable by other users. The key is never printed.
 * --vaults defaults to the vaults in --deployment's settings, and without one to the web app's launch vaults for the RPC's chain.
 * --dry-run reads the chain and lists what would be sent, without sending.
 * Chain 4663 (Robinhood Chain) and Base are refused unless --mainnet is given.
 */
import { readFileSync, statSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, isAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { alarmBookAbi } from "../src/chain/abi";
import { keyOf, Kind, registrationOrder, type Detector } from "../src/api/presets";
import { CHAINS } from "../../web/src/config";
import { MAINNETS } from "./plan";

/**
 * The vaults to register when --vaults is not given: the deployment's own launch vaults, or the web app's for that chain. A
 * Base AlarmBook must never get Robinhood Chain's list just because that network comes first in the app.
 */
export function defaultVaults(chainId: number, deployment?: { settings?: { chainId?: number; vaults?: string[] } }): string[] {
  const s = deployment?.settings;
  if (s?.vaults?.length) {
    if (s.chainId !== undefined && s.chainId !== chainId) throw new Refused(`the deployment is for chain ${s.chainId}, but the RPC is on chain ${chainId}`);
    return s.vaults;
  }
  const web = CHAINS.find((c) => c.chainId === chainId);
  if (!web) throw new Refused(`the web app has no vaults for chain ${chainId}. Pass --vaults.`);
  return web.vaults.map((v) => v.address as string);
}

/** Gas floor for a registration. AlarmBook reads the target with a full 1M gas, and a SHARE_DROP reads twice. */
export const REGISTER_GAS_FLOOR = 1_600_000n;
const pausedAbi = parseAbi(["function paused() view returns (bool)"]);
const shareAbi = parseAbi(["function decimals() view returns (uint8)", "function convertToAssets(uint256) view returns (uint256)"]);
const KIND_NAMES = ["PRICE_BELOW", "SHARE_DROP", "PAUSED", "ADDRESS_CHANGE", "DRAIN", "QUORUM", "BOTH"];

export interface RegisterDeps {
  client: Pick<PublicClient, "getChainId" | "readContract" | "estimateGas" | "waitForTransactionReceipt"> & Partial<Pick<PublicClient, "call">>;
  /** Sends a transaction from the key and returns its hash. */
  send: (tx: { to: Address; data: Hex; gas: bigint }) => Promise<Hex>;
  /** The sending account, only for estimating. */
  account: Address;
  log: (line: string) => void;
}

export interface RegisterOptions {
  book: Address;
  vaults: Address[];
  /** Allow a chain in MAINNETS. */
  mainnet: boolean;
  dryRun: boolean;
}

export interface RegisterResult { registered: number; skipped: number; wouldSend: number }

/** Thrown for a refusal that should stop the run before anything is sent. */
export class Refused extends Error {}

export async function registerPresets(d: RegisterDeps, o: RegisterOptions): Promise<RegisterResult> {
  const chainId = await d.client.getChainId();
  if (MAINNETS.includes(chainId) && !o.mainnet) {
    throw new Refused(`chain ${chainId} is a mainnet. Nothing was sent. Pass --mainnet if that is what you mean.`);
  }
  if (o.vaults.length === 0) throw new Refused("no vaults to register");
  const code = await d.client.readContract({ address: o.book, abi: alarmBookAbi, functionName: "ADMIN" }).catch(() => null);
  if (code === null) throw new Refused(`${o.book} does not answer like an AlarmBook on chain ${chainId}`);

  const res: RegisterResult = { registered: 0, skipped: 0, wouldSend: 0 };
  for (const vault of o.vaults) {
    // A vault gets the Paused alarm only if it answers paused(): on any other it could never fire.
    const paused = await d.client.readContract({ address: vault, abi: pausedAbi, functionName: "paused" }).then(() => true, () => false);
    const list = registrationOrder(vault, vault, { paused });
    d.log(`${vault}: ${list.length} alarms${paused ? " (answers paused())" : ""}`);
    for (const det of list) {
      const key = keyOf(det);
      const state = await d.client.readContract({ address: o.book, abi: alarmBookAbi, functionName: "state", args: [key] });
      const label = `${KIND_NAMES[det.kind] ?? det.kind} ${key.slice(0, 10)}`;
      if (state[0]) {
        res.skipped++;
        d.log(`  skip     ${label} (already registered)`);
        // Registration is open, so someone else may have registered this key first, and AlarmBook took its baseline from
        // whatever the target read at that moment. A baseline that is off would make the alarm fire at once or never.
        for (const w of await baselineWarnings(d, det, state[3] as bigint)) d.log(`  WARNING  ${label}: ${w}`);
        continue;
      }
      if (o.dryRun) {
        res.wouldSend++;
        d.log(`  would register ${label}`);
        continue;
      }
      await registerOne(d, o.book, det, label);
      res.registered++;
    }
  }
  d.log(o.dryRun ? `dry run: ${res.wouldSend} to send, ${res.skipped} already registered` : `done: ${res.registered} registered, ${res.skipped} already registered`);
  return res;
}

/** Why the baseline of an alarm registered by someone else looks wrong for its target. Empty when it looks right or can't be told. */
export async function baselineWarnings(d: Pick<RegisterDeps, "client">, det: Detector, baseline: bigint): Promise<string[]> {
  try {
    if (det.kind === Kind.DRAIN) {
      return baseline === 0n ? ["the DRAIN reference is zero, so it can never read a drop. Do not rely on this alarm."] : [];
    }
    if (det.kind === Kind.SHARE_DROP) {
      const decimals = await d.client.readContract({ address: det.target, abi: shareAbi, functionName: "decimals" });
      const now = await d.client.readContract({ address: det.target, abi: shareAbi, functionName: "convertToAssets", args: [10n ** BigInt(decimals)] });
      // The baseline is the high-water mark and only rises: one more than half a percent above today's price fires at the first poke.
      return baseline * 10_000n > now * 10_050n
        ? [`the share-price baseline ${baseline} is more than 0.5% above the current price ${now}. It reads as dropped, and will fire or refuse to arm at once.`]
        : [];
    }
    if (det.kind === Kind.ADDRESS_CHANGE) {
      if (!d.client.call) return [];
      const out = await d.client.call({ to: det.target, data: det.a.slice(0, 10) as Hex });
      const current = out.data && out.data.length >= 66 ? BigInt(out.data.slice(0, 66)) : null;
      if (current === null) return [];
      return current !== baseline
        ? [`the registered address 0x${baseline.toString(16).padStart(40, "0")} is not the current one 0x${current.toString(16).padStart(40, "0")}. It reads as changed already.`]
        : [];
    }
  } catch {
    // A target that can't be read is the registrant's problem; the run goes on.
  }
  return [];
}

async function registerOne(d: RegisterDeps, book: Address, det: Detector, label: string) {
  const data = encodeFunctionData({ abi: alarmBookAbi, functionName: "register", args: [det] });
  // The estimate fails for a vault that can't be read (BadDetector), which stops the run with the reason.
  const estimate = await d.client.estimateGas({ account: d.account, to: book, data }).catch((e: Error) => {
    throw new Error(`${label} would be refused: ${e.message.split("\n")[0]}`);
  });
  const gas = estimate * 13n / 10n > REGISTER_GAS_FLOOR ? (estimate * 13n) / 10n : REGISTER_GAS_FLOOR;
  const hash = await d.send({ to: book, data, gas });
  const receipt = await d.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  d.log(`  register ${label}  tx ${hash}`);
}

/** The key from a file: one hex string. The file must be private to its owner. */
export function readKeyFile(path: string): Hex {
  const mode = statSync(path).mode & 0o077;
  if (mode !== 0) throw new Refused(`${path} is readable by other users. Run: chmod 600 ${path}`);
  const raw = readFileSync(path, "utf8").trim();
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Refused(`${path} should hold one private key as 64 hex characters`);
  return hex as Hex;
}

/** Command line flags: --name value, or --name alone for a switch. */
export function parseArgs(argv: string[]): { values: Record<string, string>; flags: Set<string> } {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const switches = new Set(["mainnet", "dry-run"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Refused(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (switches.has(name)) flags.add(name);
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Refused(`--${name} needs a value`);
      values[name] = v;
    }
  }
  return { values, flags };
}

if (import.meta.main) {
  try {
    const { values, flags } = parseArgs(process.argv.slice(2));
    if (!values.rpc || !values["key-file"] || (!values.book && !values.deployment)) {
      throw new Refused("usage: bun deploy/register-presets.ts --rpc <url> --key-file <file> (--book <address> | --deployment <deployment.json>) [--vaults <a,b,...>] [--dry-run] [--mainnet]");
    }
    const deployment = values.deployment ? (JSON.parse(readFileSync(values.deployment, "utf8")) as { alarmBook: string; settings?: { chainId?: number; vaults?: string[] } }) : undefined;
    const book = (values.book ?? deployment!.alarmBook) as Address;
    if (!isAddress(book)) throw new Refused("the AlarmBook address is not valid");

    const transport = http(values.rpc);
    const client = createPublicClient({ transport }) as PublicClient;
    const vaults = (values.vaults ? values.vaults.split(",") : defaultVaults(await client.getChainId(), deployment)).map((v) => v.trim());
    if (!vaults.every((v) => isAddress(v))) throw new Refused("--vaults holds an address that is not valid");
    const account = privateKeyToAccount(readKeyFile(values["key-file"]));
    const wallet = createWalletClient({ account, transport });
    await registerPresets(
      { client, account: account.address, log: console.log, send: (tx) => wallet.sendTransaction({ ...tx, chain: null } as never) },
      { book: getAddress(book), vaults: vaults.map((v) => getAddress(v)), mainnet: flags.has("mainnet"), dryRun: flags.has("dry-run") },
    );
    process.exit(0);
  } catch (e) {
    console.error(`STOP: ${(e as Error).message}`);
    process.exit(1);
  }
}
