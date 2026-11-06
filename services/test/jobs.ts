import type { Address } from "viem";
import { isPreset } from "../src/api/presets";
import type { ExitJob } from "../src/keeper/keeper";
import type { Repo } from "../src/store/repo";

/**
 * Queues an exit job as the keeper would: the position is armed in the database with the job's key (a job ends once its
 * position or key is gone), and the payload says whether the key is one of the vault's own presets.
 */
export async function enqueueExit(r: Repo, dedupe: string, job: ExitJob, runAt: number, adapter: Address = job.target) {
  await r.upsertPosition({
    posId: job.posId, owner: job.owner.toLowerCase(), adapter, target: job.target.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [job.key],
  });
  await r.enqueue("exit", dedupe, { ...job, preset: isPreset(job.target, job.key) }, runAt);
}
