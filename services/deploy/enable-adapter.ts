/**
 * Writes the Safe batch that enables the Uniswap v3 adapter on a live router: Timelock schedule + execute of
 * setAdapter(adapter, true). Holds no keys and sends nothing. With an RPC, it first checks the adapter on chain.
 * Usage: bun deploy/enable-adapter.ts <deployment.json> <adapter> <out dir> [rpc]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, getAddress, http, parseAbi, type Address, type PublicClient } from "viem";
import { routerAbi } from "../src/chain/abi";
import { BASE, ROBINHOOD } from "../src/chain/addresses";
import { adminChangeFiles, delayOf, enableAdapterCall, type Deployment, type Settings } from "./plan";

export const ADAPTER_NAME = "UniswapV3Adapter";
const SLUG = "enable-uniswap-v3-adapter";

const POSITIONS: Record<number, Address> = { [BASE.chainId]: BASE.uniswapV3Positions, [ROBINHOOD.chainId]: ROBINHOOD.uniswapV3Positions };

const adapterAbi = parseAbi([
  "function ROUTER() view returns (address)",
  "function POSITIONS() view returns (address)",
  "function positionAsset(address) view returns (address, bool)",
]);

/** Problems with the deployed adapter, empty when it is safe to enable. */
export async function checkAdapter(client: Pick<PublicClient, "getCode" | "readContract">, d: Deployment, chainId: number, adapter: Address): Promise<string[]> {
  const out: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const code = await client.getCode({ address: adapter });
  if (!code || code === "0x") return ["no contract at the adapter address"];
  const pinned = POSITIONS[chainId];
  const router = await client.readContract({ address: adapter, abi: adapterAbi, functionName: "ROUTER" });
  const positions = await client.readContract({ address: adapter, abi: adapterAbi, functionName: "POSITIONS" });
  if (!same(router, d.router)) out.push(`adapter is wired to router ${router}, not ${d.router}`);
  if (!pinned) out.push(`no Uniswap v3 position manager pinned for chain ${chainId}`);
  else if (!same(positions, pinned)) out.push(`adapter uses position manager ${positions}, not ${pinned}`);
  const [asset, isNft] = await client.readContract({ address: adapter, abi: adapterAbi, functionName: "positionAsset", args: [positions] });
  if (!same(asset, positions) || !isNft) out.push("adapter does not report the position manager's NFTs");
  if (await client.readContract({ address: d.router, abi: routerAbi, functionName: "adapterAllowed", args: [adapter] })) out.push("adapter is already enabled");
  return out;
}

export function enableAdapterFiles(d: Deployment, s: Settings, adapter: Address) {
  return adminChangeFiles(d.timelock, s.chainId, delayOf(s), SLUG, [enableAdapterCall(d.router, adapter, ADAPTER_NAME)]);
}

if (import.meta.main) {
  const [deployment, adapterArg, out, rpc] = process.argv.slice(2);
  if (!deployment || !adapterArg || !out) throw new Error("usage: bun deploy/enable-adapter.ts <deployment.json> <adapter> <out dir> [rpc]");
  const { settings, ...d } = JSON.parse(readFileSync(deployment, "utf8")) as Deployment & { settings: Settings };
  const adapter = getAddress(adapterArg);
  if (rpc) {
    const problems = await checkAdapter(createPublicClient({ transport: http(rpc) }), d, settings.chainId, adapter);
    if (problems.length) throw new Error(`refusing to write the batch:\n- ${problems.join("\n- ")}`);
    console.log("adapter checks passed");
  } else {
    console.warn("no RPC given, so the adapter was not checked on chain");
  }
  mkdirSync(out, { recursive: true });
  for (const [file, batch] of enableAdapterFiles(d, settings, adapter)) {
    writeFileSync(join(out, file), `${JSON.stringify(batch, null, 2)}\n`);
    console.log(`wrote ${join(out, file)}`);
  }
}
