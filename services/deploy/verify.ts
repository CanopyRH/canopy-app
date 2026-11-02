/**
 * Independent check of a live deployment against the tested build and the intended settings.
 * Values are compared to deployment.json, never read back from the contracts being checked.
 * Usage: bun deploy/verify.ts <deployment.json> <rpc url> <deployed|live>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { alarmBookAbi, routerAbi } from "../src/chain/abi";
import { delayOf, MAINNETS, type Deployment, type Settings } from "./plan";

const OUT = join(import.meta.dir, "../../contracts/out");
const timelockAbi = parseAbi(["function PROPOSER() view returns (address)", "function DELAY() view returns (uint256)"]);
const adapterAbi = parseAbi(["function ROUTER() view returns (address)"]);

export interface Check { name: string; ok: boolean; detail?: string }

/** Runtime code with immutable slots blanked, since those hold deployment-specific values checked separately. */
function masked(code: string, refs: Record<string, { start: number; length: number }[]>): string {
  const chars = code.replace(/^0x/, "").split("");
  for (const list of Object.values(refs)) {
    for (const { start, length } of list) chars.fill("0", start * 2, (start + length) * 2);
  }
  return chars.join("");
}

function artifact(file: string) {
  const a = JSON.parse(readFileSync(join(OUT, file), "utf8"));
  return { code: a.deployedBytecode.object as string, refs: (a.deployedBytecode.immutableReferences ?? {}) as Record<string, { start: number; length: number }[]> };
}
