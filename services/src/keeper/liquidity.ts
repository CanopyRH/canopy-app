import { encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { vaultV2Abi } from "../chain/abi";

const adapterAbi = parseAbi([
  "function marketIdsLength() view returns (uint256)",
  "function marketIds(uint256) view returns (bytes32)",
]);
const morphoAbi = parseAbi([
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function position(bytes32,address) view returns (uint256,uint128,uint128)",
  "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
]);
const PARAMS = [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }] as const;

export interface PlainCall { to: Address; data: Hex; gas?: bigint }

/** The most a vault can pull from one market: its own supply, capped by what borrowers left free. A vault is often a small lender in a big market. */
export function reachableAssets(totalSupplyAssets: bigint, totalSupplyShares: bigint, totalBorrowAssets: bigint, vaultShares: bigint): bigint {
  if (totalSupplyShares === 0n) return 0n;
  const free = totalSupplyAssets - totalBorrowAssets;
  const own = (vaultShares * totalSupplyAssets) / totalSupplyShares;
  return own < free ? own : free;
}

/** Calls that move free market liquidity into vault idle. Empty unless this is a Vault V2 with a 0 penalty. */
export async function deallocateCalls(client: PublicClient, morpho: Address, vault: Address, onBehalf: Address): Promise<PlainCall[]> {
  try {
    const adapter = await client.readContract({ address: vault, abi: vaultV2Abi, functionName: "liquidityAdapter" });
    const penalty = await client.readContract({ address: vault, abi: vaultV2Abi, functionName: "forceDeallocatePenalty", args: [adapter] });
    if (penalty !== 0n) return [];
    const n = await client.readContract({ address: adapter, abi: adapterAbi, functionName: "marketIdsLength" });
    const calls: PlainCall[] = [];
    for (let i = 0n; i < n; i++) {
      const id = await client.readContract({ address: adapter, abi: adapterAbi, functionName: "marketIds", args: [i] });
      const m = await client.readContract({ address: morpho, abi: morphoAbi, functionName: "market", args: [id] });
      const [shares] = await client.readContract({ address: morpho, abi: morphoAbi, functionName: "position", args: [id, adapter] });
      const reachable = reachableAssets(m[0], m[1], m[2], shares);
      if (reachable < 1_000_000_000n) continue;
      const p = await client.readContract({ address: morpho, abi: morphoAbi, functionName: "idToMarketParams", args: [id] });
      calls.push({
        to: vault,
        data: encodeFunctionData({
          abi: vaultV2Abi,
          functionName: "forceDeallocate",
          args: [adapter, encodeAbiParameters(PARAMS, p), (reachable * 999n) / 1000n, onBehalf],
        }),
      });
    }
    return calls;
  } catch {
    return []; // Vault V1 and other adapters have no such path. The plain exit still runs.
  }
}
