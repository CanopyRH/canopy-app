/**
 * Registers every launch vault's alarm presets on an AlarmBook. Registration is open to anyone, so any funded key will do: it
 * needs gas and nothing else, and it holds no rights. Alarms already registered are skipped, so a run can be repeated or
 * resumed after a failure. Each transaction is printed as it lands.
 *
 * Usage: bun deploy/register-presets.ts --rpc <url> --key-file <file> (--book <address> | --deployment <deployment.json>)
 *          [--vaults <a,b,...>] [--dry-run] [--mainnet]
 *
 * --key-file holds one private key in hex, and nothing else. It must not be readable by other users. The key is never printed.
 * --vaults defaults to the web app's launch vaults.
 * --dry-run reads the chain and lists what would be sent, without sending.
 * Chain 4663 (Robinhood Chain) and Base are refused unless --mainnet is given.
 */
import { readFileSync, statSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, isAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { alarmBookAbi } from "../src/chain/abi";
import { keyOf, registrationOrder, type Detector } from "../src/api/presets";
import { CONFIG } from "../../web/src/config";
import { MAINNETS } from "./plan";

/** Gas floor for a registration. AlarmBook reads the target with a full 1M gas, and a SHARE_DROP reads twice. */
export const REGISTER_GAS_FLOOR = 1_600_000n;
const pausedAbi = parseAbi(["function paused() view returns (bool)"]);
const KIND_NAMES = ["PRICE_BELOW", "SHARE_DROP", "PAUSED", "ADDRESS_CHANGE", "DRAIN", "QUORUM", "BOTH"];

export interface RegisterDeps {
  client: Pick<PublicClient, "getChainId" | "readContract" | "estimateGas" | "waitForTransactionReceipt">;
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
    const book = (values.book ?? (JSON.parse(readFileSync(values.deployment!, "utf8")) as { alarmBook: string }).alarmBook) as Address;
    if (!isAddress(book)) throw new Refused("the AlarmBook address is not valid");

    const vaults = (values.vaults ? values.vaults.split(",") : CONFIG.vaults.map((v) => v.address as string)).map((v) => v.trim());
    if (!vaults.every((v) => isAddress(v))) throw new Refused("--vaults holds an address that is not valid");
    const account = privateKeyToAccount(readKeyFile(values["key-file"]));
    const transport = http(values.rpc);
    const client = createPublicClient({ transport }) as PublicClient;
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
