import { parseAbi, type Address } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000";

export const gateAbi = parseAbi([
  "function sendSharesGate() view returns (address)",
  "function receiveSharesGate() view returns (address)",
  "function receiveAssetsGate() view returns (address)",
  "function canSendShares(address) view returns (bool)",
  "function canReceiveShares(address) view returns (bool)",
  "function canReceiveAssets(address) view returns (bool)",
]);

export type Read = (address: Address, functionName: string, args?: unknown[]) => Promise<unknown>;

/** Which gate a Canopy exit passes through, and who has to be let through it. */
const paths = (owner: Address, adapter: Address, router: Address) => [
  { gate: "sendSharesGate", can: "canSendShares", who: [owner, adapter] },
  { gate: "receiveSharesGate", can: "canReceiveShares", who: [adapter] },
  { gate: "receiveAssetsGate", can: "canReceiveAssets", who: [router] },
];

/** True when a vault's gates would block an exit through Canopy. A vault with no gates, such as Vault V1, is never blocked. */
export async function exitBlocked(read: Read, vault: Address, owner: Address, adapter: Address, router: Address): Promise<boolean> {
  const steps = paths(owner, adapter, router);
  const gates = await Promise.all(steps.map(({ gate }) => read(vault, gate).catch(() => null)));
  if (gates.every((g) => g === null)) return false; // No gate functions at all.
  if (gates.some((g) => g === null)) return true; // Some can't be read, so this can't be called safe.
  for (const [i, { can, who }] of steps.entries()) {
    const address = gates[i];
    if (address === ZERO) continue;
    for (const w of who) {
      const allowed = await read(address as Address, can, [w]).catch(() => false);
      if (allowed !== true) return true;
    }
  }
  return false;
}
