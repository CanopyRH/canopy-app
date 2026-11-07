import { keccak256, zeroAddress, type Address, type Hex } from "viem";
import { type Observation } from "./core";

export const PROXY_SLOTS = {
  implementation:
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex,
  admin:
    "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex,
  beacon:
    "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as Hex,
};
export function slotAddress(value: Hex | null): Address | null {
  if (value === null) return null;
  if (value === "0x") return zeroAddress;
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) return null;
  return `0x${value.slice(-40)}` as Address;
}
export async function inspectControl(o: Observation, at: Address) {
  const [code, implementation, admin, beacon] = await Promise.all([
    o.code(at),
    ...Object.values(PROXY_SLOTS).map((slot) => o.slot(at, slot)),
  ]);
  const slots = {
    implementation: slotAddress(implementation ?? null),
    admin: slotAddress(admin ?? null),
    beacon: slotAddress(beacon ?? null),
  };
  const delegated =
    code && /^0xef0100[0-9a-fA-F]{40}$/.test(code)
      ? (`0x${code.slice(8)}` as Address)
      : null;
  const beaconImplementation =
    slots.beacon && slots.beacon !== zeroAddress
      ? await o.read<Address>(slots.beacon, "implementation")
      : null;
  const target =
    delegated ??
    (slots.implementation && slots.implementation !== zeroAddress
      ? slots.implementation
      : beaconImplementation);
  const targetCode = target ? await o.code(target) : null;
  return {
    address: at,
    codeHash: code && code !== "0x" ? keccak256(code) : null,
    kind:
      code === null
        ? "unknown"
        : code === "0x"
          ? "no-code-at-block"
          : delegated
            ? "delegated-code"
            : "contract",
    slots,
    delegation: delegated,
    beaconImplementation,
    implementationCodeHash:
      targetCode && targetCode !== "0x" ? keccak256(targetCode) : null,
  };
}
export async function controlMap(o: Observation, vault: Address) {
  const names = ["owner", "curator", "guardian"];
  const roles = await Promise.all(
    names.map(async (name) => ({
      name,
      address: await o.read<Address>(vault, name),
    })),
  );
  const unique = [
    ...new Set(
      [
        vault,
        ...roles.flatMap((r) =>
          r.address && r.address !== zeroAddress ? [r.address] : [],
        ),
      ].map((a) => a.toLowerCase()),
    ),
  ];
  const controls = [];
  for (const at of unique)
    controls.push(await inspectControl(o, at as Address));
  return o.finish("controls", { vault, roles, controls }, [
    "No-code does not prove a human-controlled EOA. Delegation and standard proxy slots are observations, not a complete authority audit.",
    "Custom proxies, hidden roles, multisig thresholds and timelock enforcement need separate review. A zero slot does not prove immutability.",
  ]);
}
