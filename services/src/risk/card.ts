import { toFunctionSelector, type Address, type PublicClient } from "viem";
import { erc20Abi, vaultAbi, vaultV2Abi } from "../chain/abi";

export interface CardNumbers {
  vault: Address;
  name: string;
  assetSymbol: string;
  assetDecimals: number;
  totalAssets: string | null;
  version: "v1" | "v2" | "other";
  owner: Address | null;
  curator: Address | null;
  idleAssets: string;
  gates: { name: string; address: Address | null; abdicated: boolean | null }[];
  forceDeallocatePenaltyZero: boolean | null;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const GATES = [
  ["sendSharesGate", "setSendSharesGate(address)"],
  ["receiveSharesGate", "setReceiveSharesGate(address)"],
  ["receiveAssetsGate", "setReceiveAssetsGate(address)"],
] as const;

const attempt = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

/** Reads facts only. A failed read becomes null, shown as "unknown", never as safe. */
export async function readCard(client: PublicClient, vault: Address): Promise<CardNumbers> {
  const read = <T>(abi: never, functionName: string, args: unknown[] = []) =>
    attempt(client.readContract({ address: vault, abi, functionName, args } as never) as Promise<T>);
  const v = vaultAbi as never;
  const v2 = vaultV2Abi as never;
  const [name, asset, totalAssets, owner, curator, adapters] = await Promise.all([
    read<string>(v, "name"),
    read<Address>(v, "asset"),
    read<bigint>(v, "totalAssets"),
    read<Address>(v, "owner"),
    read<Address>(v, "curator"),
    read<bigint>(v2, "adaptersLength"),
  ]);
  if (!asset) throw new Error(`not an ERC-4626 vault: ${vault}`);
  const [assetSymbol, assetDecimals, idle] = await Promise.all([
    client.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
  ]);
  const isV2 = adapters !== null;
  const gates = await Promise.all(
    GATES.map(async ([g, setter]) => ({
      name: g,
      address: isV2 ? await read<Address>(v2, g) : null,
      abdicated: isV2 ? await read<boolean>(v2, "abdicated", [toFunctionSelector(`function ${setter}`)]) : null,
    })),
  );
  let penaltyZero: boolean | null = null;
  if (isV2) {
    const la = await read<Address>(v2, "liquidityAdapter");
    if (la && la !== ZERO) {
      const pen = await read<bigint>(v2, "forceDeallocatePenalty", [la]);
      penaltyZero = pen === null ? null : pen === 0n;
    }
  }
  return {
    vault, name: name ?? "Unnamed vault", assetSymbol, assetDecimals, totalAssets: totalAssets === null ? null : totalAssets.toString(),
    version: isV2 ? "v2" : curator ? "v1" : "other", owner, curator, idleAssets: idle.toString(), gates, forceDeallocatePenaltyZero: penaltyZero,
  };
}

const fmt = (raw: string, dec: number) => {
  const n = Number(BigInt(raw) / 10n ** BigInt(Math.max(dec - 2, 0))) / 100;
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
};
const short = (a: Address | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "unknown");

/** Plain-words card. Facts only: no ratings, no advice, no AI wording. */
export function cardText(c: CardNumbers): string {
  const lines = [
    c.name,
    c.totalAssets === null ? "Total held: unknown." : `Holds about ${fmt(c.totalAssets, c.assetDecimals)} ${c.assetSymbol}.`,
    `Who can change it: owner ${short(c.owner)}, curator ${short(c.curator)}.`,
    `Sitting idle in the vault now: about ${fmt(c.idleAssets, c.assetDecimals)} ${c.assetSymbol}. More may be withdrawable from its markets.`,
  ];
  if (c.version === "v2") {
    // Giving up a gate freezes it as it stands, so a gate can be set for good.
    const on = c.gates.filter((g) => g.address !== null && g.address !== ZERO);
    const open = c.gates.filter((g) => !on.includes(g) && (g.abdicated !== true || g.address === null));
    if (on.length > 0) lines.push(`Withdrawal gates: ${on.map((g) => g.name).join(", ")} ${on.length === 1 ? "is" : "are"} on now. An exit may be blocked.`);
    if (open.length > 0) lines.push(`Withdrawal gates: ${open.map((g) => g.name).join(", ")} could still be turned on. An exit could be blocked if they are.`);
    if (on.length === 0 && open.length === 0) lines.push("Withdrawal gates: none are on, and the curator has permanently given up setting them.");
  }
  return lines.join("\n");
}
