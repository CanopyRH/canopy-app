import { parseAbi, type Address, type Hex, type PublicClient } from "viem";
import type { Repo } from "../store/repo";
import { adminChanges, drainVelocity, paused, shareDrop, type Signal } from "./index";

const scanAbi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function curator() view returns (address)",
]);

const DRAIN_WINDOW = 3600;
const DRAIN_BPS = 2500n;
const SHARE_DROP_BPS = 50n;
const HIGH_WINDOW = 30 * 86_400; // One odd reading can't set off alerts forever.

export interface ScanDeps {
  client: Pick<PublicClient, "readContract" | "getCode">;
  repo: Repo;
  now: () => number;
}

/**
 * One pass over a vault. Returns everything the chain shows right now, for follower alerts.
 * Only soft signals are stored for watchers: a hard signal in that list would hide them from decide(), and it needs no quorum anyway.
 * A vault with no code here belongs to another chain, so it is skipped.
 */
export async function scanVault(d: ScanDeps, target: Address): Promise<Signal[]> {
  const code = await d.client.getCode({ address: target });
  if (!code || code === "0x") return [];
  const now = d.now();
  // Each read stands alone. A vault that stops pricing while paused must still report the pause.
  const read = <T>(functionName: string, args: unknown[] = []) =>
    (d.client.readContract({ address: target, abi: scanAbi, functionName, args } as never) as Promise<T>).catch(() => null);

  const [totalAssets, sharePrice, isPaused, owner, curator] = await Promise.all([
    read<bigint>("totalAssets"),
    read<bigint>("convertToAssets", [10n ** 18n]),
    read<boolean>("paused"),
    read<Address>("owner"),
    read<Address>("curator"),
  ]);

  const high = await d.repo.highSharePrice(target, now - HIGH_WINDOW);
  if (totalAssets !== null && sharePrice !== null) await d.repo.recordSnap(target, now, totalAssets, sharePrice);
  const prev = await d.repo.admins(target);
  await d.repo.saveAdmins(target, { owner: owner ?? prev?.owner ?? null, curator: curator ?? prev?.curator ?? null });

  const hex = target as Hex;
  const soft = [drainVelocity(await d.repo.snaps(target, now - DRAIN_WINDOW), DRAIN_WINDOW, DRAIN_BPS, hex), ...adminChanges(prev, { owner, curator }, hex, now)].filter((s) => s !== null);
  for (const s of soft) await d.repo.recordSignal(s);
  const hard = [paused(isPaused === true, hex, now), sharePrice === null ? null : shareDrop(high, sharePrice, SHARE_DROP_BPS, hex, now)].filter((s) => s !== null);
  return [...hard, ...soft];
}
