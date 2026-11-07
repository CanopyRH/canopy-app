/** Read-only deployment/rotation preflight. Never sends or signs a Safe transaction. */
import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { z } from "zod";
import { readFileSync } from "node:fs";
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const GovernanceInput = z.strictObject({
  chainId: z.number().int().positive(),
  timelock: addr,
  admin: addr,
  guardian: addr,
  payments: addr,
});
const abi = parseAbi([
  "function DELAY() view returns(uint256)",
  "function PROPOSER() view returns(address)",
  "function getOwners() view returns(address[])",
  "function getThreshold() view returns(uint256)",
]);
export async function checkGovernance(
  client: Pick<PublicClient, "getChainId" | "getBlock" | "readContract">,
  raw: unknown,
) {
  const cfg = GovernanceInput.parse(raw);
  if ((await client.getChainId()) !== cfg.chainId)
    throw Error("Wrong RPC chain");
  const b = await client.getBlock();
  if (b.number === null) throw Error("Mined block required");
  const call = (address: string, functionName: string) =>
    client.readContract({
      address: address as Address,
      abi,
      functionName,
      blockNumber: b.number,
    } as never) as Promise<any>;
  const delay = (await call(cfg.timelock, "DELAY")) as bigint,
    proposer = (await call(cfg.timelock, "PROPOSER")) as string;
  const safes = await Promise.all(
    (["admin", "guardian", "payments"] as const).map(async (role) => ({
      role,
      address: cfg[role],
      owners: ((await call(cfg[role], "getOwners")) as string[])
        .map((x) => x.toLowerCase())
        .sort(),
      threshold: Number(await call(cfg[role], "getThreshold")),
    })),
  );
  const issues: string[] = [];
  if (delay < 604800n)
    issues.push(
      "Timelock delay is below seven days; immutable deployments require migration.",
    );
  if (proposer.toLowerCase() !== cfg.admin.toLowerCase())
    issues.push("Timelock proposer differs from the supplied admin.");
  for (const s of safes)
    if (
      !Number.isSafeInteger(s.threshold) ||
      s.owners.includes("0x" + "0".repeat(40)) ||
      s.threshold < 2 ||
      s.threshold > s.owners.length ||
      s.owners.length > 32 ||
      new Set(s.owners).size !== s.owners.length
    )
      issues.push(
        `${s.role} has an invalid or insufficient threshold/owner set.`,
      );
  for (let i = 0; i < safes.length; i++)
    for (let j = i + 1; j < safes.length; j++)
      if (safes[i]!.owners.some((o) => safes[j]!.owners.includes(o)))
        issues.push(
          `${safes[i]!.role} and ${safes[j]!.role} share owners; use separately controlled signers.`,
        );
  if ((await client.getBlock({ blockNumber: b.number })).hash !== b.hash)
    throw Error("Snapshot changed");
  return {
    chainId: cfg.chainId,
    block: String(b.number),
    hash: b.hash,
    timelockDelay: String(delay),
    safes,
    ready: issues.length === 0,
    issues,
    limitations: [
      "Owner addresses and contract-reported thresholds do not establish human independence or verify Safe bytecode/modules. Review those separately. No changes are submitted.",
    ],
  };
}
if (import.meta.main) {
  try {
    const [file, rpc] = process.argv.slice(2);
    if (!file || !rpc) throw Error("Supply configuration file and RPC");
    const report = await checkGovernance(
      createPublicClient({
        transport: http(rpc, { timeout: 5000, retryCount: 0 }),
      }),
      JSON.parse(readFileSync(file, "utf8")),
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 2;
  } catch {
    console.error(
      "Governance preflight failed; check configuration and RPC. Nothing was submitted.",
    );
    process.exitCode = 1;
  }
}
