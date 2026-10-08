export interface OpsReading { lagBlocks: bigint; gasWei: bigint; minGasWei: bigint; oldestJobSec: number; maxLagBlocks?: bigint }
export interface OpsProblem { code: string; text: string }

const MAX_JOB_SEC = 300;

/** What an operator needs to hear about. Each code is sent at most once an hour. */
export function opsProblems(r: OpsReading): OpsProblem[] {
  const out: OpsProblem[] = [];
  if (r.lagBlocks > (r.maxLagBlocks ?? 20n)) out.push({ code: "lag", text: `Canopy ops: the indexer is ${r.lagBlocks} blocks behind.` });
  if (r.gasWei < r.minGasWei) out.push({ code: "gas", text: `Canopy ops: the keeper is low on gas, with ${r.gasWei} wei left.` });
  if (r.oldestJobSec > MAX_JOB_SEC) out.push({ code: "jobs", text: `Canopy ops: an exit job has been open for ${r.oldestJobSec} seconds.` });
  return out;
}
