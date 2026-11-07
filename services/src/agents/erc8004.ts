import { z } from "zod";
import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  toHex,
  type PublicClient,
  type Address,
  type Hex,
} from "viem";
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v as Address);
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v as Hex);
const https = z
  .string()
  .url()
  .max(2048)
  .refine(
    (v) =>
      new URL(v).protocol === "https:" &&
      !new URL(v).username &&
      !new URL(v).password,
  );
export const Registration = z.strictObject({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(2000),
  image: https,
  services: z
    .array(
      z.strictObject({
        name: z.enum(["web", "MCP"]),
        endpoint: https,
        version: z.string().max(40).optional(),
      }),
    )
    .max(8),
  active: z.boolean(),
});
export const IdentityRequest = z.strictObject({
  chainId: z.number().int().positive(),
  registry: address,
  codeHash: hash,
  owner: address,
  implementation: z.strictObject({ address, codeHash: hash }).optional(),
  agentId: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,77})$/)
    .optional(),
  registration: Registration,
});
const abi = parseAbi([
  "function register(string agentURI) returns(uint256 agentId)",
  "function setAgentURI(uint256 agentId,string newURI)",
  "function ownerOf(uint256 agentId) view returns(address)",
]);
const slot = (name: string) =>
  toHex(BigInt(keccak256(toHex(name))) - 1n, { size: 32 });
/** Discovery metadata only: identity is not proof of safety, reputation, bond membership or successful exits. */
export async function prepareIdentity(client: PublicClient, raw: unknown) {
  const r = IdentityRequest.parse(raw);
  if ((await client.getChainId()) !== r.chainId)
    throw new Error("Wrong identity registry chain");
  const block = await client.getBlock();
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(block.timestamp)) > 60)
    throw new Error("Stale chain head");
  const code = await client.getCode({
    address: r.registry,
    blockNumber: block.number,
  });
  if (
    !code ||
    code === "0x" ||
    keccak256(code).toLowerCase() !== r.codeHash.toLowerCase()
  )
    throw new Error("Unreviewed registry code");
  const [implementation, beacon] = await Promise.all(
    ["implementation", "beacon"].map((name) =>
      client.getStorageAt({
        address: r.registry,
        slot: slot("eip1967.proxy." + name),
        blockNumber: block.number,
      }),
    ),
  );
  if (!implementation || !beacon)
    throw new Error("Registry proxy state unavailable");
  if (BigInt(beacon) !== 0n)
    throw new Error("Beacon registries require a separate review");
  if (BigInt(implementation) !== 0n) {
    if (
      !r.implementation ||
      BigInt(implementation) !== BigInt(r.implementation.address)
    )
      throw new Error("Unreviewed implementation");
    const implCode = await client.getCode({
      address: r.implementation.address,
      blockNumber: block.number,
    });
    if (
      !implCode ||
      implCode === "0x" ||
      keccak256(implCode).toLowerCase() !==
        r.implementation.codeHash.toLowerCase()
    )
      throw new Error("Implementation code changed");
  } else if (r.implementation)
    throw new Error("Configured implementation is not installed");
  const id = r.agentId === undefined ? null : BigInt(r.agentId);
  if (id !== null && id >= 2n ** 256n) throw new Error("Invalid identity ID");
  if (id !== null) {
    const owner = await client.readContract({
      address: r.registry,
      abi,
      functionName: "ownerOf",
      args: [id],
      blockNumber: block.number,
    });
    if (owner.toLowerCase() !== r.owner.toLowerCase())
      throw new Error("Identity belongs to another owner");
  }
  const metadata = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    ...r.registration,
    x402Support: false,
    supportedTrust: [],
    registrations:
      id === null
        ? []
        : [
            {
              agentId: r.agentId,
              agentRegistry: `eip155:${r.chainId}:${r.registry}`,
            },
          ],
  };
  const uri =
    "data:application/json;base64," +
    Buffer.from(JSON.stringify(metadata)).toString("base64");
  const call =
    id === null
      ? { abi, functionName: "register" as const, args: [uri] as const }
      : { abi, functionName: "setAgentURI" as const, args: [id, uri] as const };
  await client.simulateContract({
    ...call,
    address: r.registry,
    account: r.owner,
    blockNumber: block.number,
  } as never);
  return {
    metadata,
    reviewedAtBlock: block.number,
    transaction: {
      chainId: r.chainId,
      from: r.owner,
      to: r.registry,
      value: 0n,
      data: encodeFunctionData(call),
    },
    notice:
      "Unsigned identity proposal. Recheck registry implementation before signing. Registration does not establish trust. Add the confirmed agent ID after registration.",
  };
}
