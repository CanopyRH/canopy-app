/**
 * Re-checks a launch vault list against the chain. Read-only: sends nothing and needs no key. Run it against a fork or the
 * live chain before a deploy, and drop any vault that fails.
 *
 * A vault passes when:
 *  - its asset is the launch stablecoin,
 *  - it holds something (totalAssets > 0) and its share price can be read (convertToAssets of one share > 0),
 *  - no share gate can block an exit: a Vault V1 has none, and a Vault V2 has its send-shares, receive-shares and
 *    receive-assets gates all unset and all abdicated, so the curator can never turn one on.
 * It also says which vaults answer paused(), for `pausedVaults`.
 *
 * Usage: bun deploy/check-vaults.ts <rpc url> <settings.json>
 */
import { readFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, toFunctionSelector, type Address, type PublicClient } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000";
const vaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function paused() view returns (bool)",
  "function adaptersLength() view returns (uint256)",
  "function abdicated(bytes4) view returns (bool)",
  "function sendSharesGate() view returns (address)",
  "function receiveSharesGate() view returns (address)",
  "function receiveAssetsGate() view returns (address)",
]);
/** The gates an exit passes through, and the setter whose abdication freezes each. */
export const EXIT_GATES = [
  ["sendSharesGate", "setSendSharesGate(address)"],
  ["receiveSharesGate", "setReceiveSharesGate(address)"],
  ["receiveAssetsGate", "setReceiveAssetsGate(address)"],
] as const;

export interface VaultReport {
  vault: Address;
  name: string | null;
  version: "v1" | "v2";
  ok: boolean;
  /** Why it fails. Empty when it passes. */
  problems: string[];
  totalAssets: bigint | null;
  sharePrice: bigint | null;
  answersPaused: boolean;
}

type Reader = Pick<PublicClient, "readContract">;

export async function checkVault(client: Reader, vault: Address, stable: Address): Promise<VaultReport> {
  const read = <T>(functionName: string, args: unknown[] = []) =>
    (client.readContract({ address: vault, abi: vaultAbi, functionName, args } as never) as Promise<T>).then((v) => v, () => null);
  const problems: string[] = [];
  const [asset, name, decimals, totalAssets, adapters] = await Promise.all([
    read<Address>("asset"), read<string>("name"), read<number>("decimals"), read<bigint>("totalAssets"), read<bigint>("adaptersLength"),
  ]);
  if (!asset) problems.push("asset() can't be read: not an ERC-4626 vault");
  else if (asset.toLowerCase() !== stable.toLowerCase()) problems.push(`asset is ${asset}, not the stablecoin`);
  if (totalAssets === null) problems.push("totalAssets() can't be read");
  else if (totalAssets === 0n) problems.push("totalAssets is zero");
  const sharePrice = decimals === null ? null : await read<bigint>("convertToAssets", [10n ** BigInt(decimals)]);
  if (!sharePrice) problems.push("the share price can't be read");
  const version = adapters === null ? "v1" : "v2";
  if (version === "v2") {
    for (const [gate, setter] of EXIT_GATES) {
      const [address, gaveUp] = await Promise.all([read<Address>(gate), read<boolean>("abdicated", [toFunctionSelector(`function ${setter}`)])]);
      if (address === null) problems.push(`${gate} can't be read`);
      else if (address !== ZERO) problems.push(`${gate} is set to ${address}`);
      if (gaveUp !== true) problems.push(`${gate} is not abdicated, so the curator can still turn it on`);
    }
  }
  const answersPaused = (await read<boolean>("paused")) !== null;
  return { vault, name, version, ok: problems.length === 0, problems, totalAssets, sharePrice, answersPaused };
}

export async function checkVaults(client: Reader, vaults: Address[], stable: Address): Promise<VaultReport[]> {
  const out: VaultReport[] = [];
  for (const v of vaults) out.push(await checkVault(client, v, stable));
  return out;
}

if (import.meta.main) {
  const [rpc, file] = process.argv.slice(2);
  if (!rpc || !file) throw new Error("usage: bun deploy/check-vaults.ts <rpc url> <settings.json>");
  const s = JSON.parse(readFileSync(file, "utf8")) as { chainId: number; stable: Address; vaults: Address[] };
  const client = createPublicClient({ transport: http(rpc) }) as PublicClient;
  const chainId = await client.getChainId();
  if (chainId !== s.chainId) throw new Error(`that RPC is on chain ${chainId}, but the settings target ${s.chainId}`);
  const block = await client.getBlockNumber();
  console.log(`chain ${chainId}, block ${block}, ${s.vaults.length} vaults`);
  const reports = await checkVaults(client, s.vaults, s.stable);
  for (const r of reports) {
    const held = r.totalAssets === null ? "?" : (r.totalAssets / 1_000_000n).toLocaleString("en-US");
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.vault}  ${r.version}  ${r.name ?? "?"}  (${held} held, share price ${r.sharePrice ?? "?"}, paused() ${r.answersPaused ? "answers" : "absent"})`);
    for (const p of r.problems) console.log(`        ${p}`);
  }
  const failed = reports.filter((r) => !r.ok);
  const paused = reports.filter((r) => r.ok && r.answersPaused).map((r) => r.vault);
  console.log(`\n${reports.length - failed.length} of ${reports.length} vaults pass. pausedVaults: ${paused.length ? paused.join(", ") : "none"}`);
  process.exit(failed.length ? 1 : 0);
}
