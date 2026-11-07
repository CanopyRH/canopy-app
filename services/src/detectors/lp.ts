import { parseAbi, type Address, type PublicClient } from "viem";
import type { Db } from "../store/db";
import type { Repo } from "../store/repo";
import type { Signal } from "./index";
const abi = parseAbi([
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function balanceOf(address) view returns(uint256)",
]);
const median = (v: bigint[]) =>
  v.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor(v.length / 2)]!;
/** Reserve reduction is soft: trades and honest withdrawals are indistinguishable from a rug by balances alone. */
export function reserveSignal(
  pool: Address,
  rows: { at: number; reserve0: bigint; reserve1: bigint }[],
  now: number,
): Signal | null {
  const sorted = rows
    .filter((r) => r.at <= now && r.at >= now - 86400)
    .sort((a, b) => a.at - b.at);
  const current = sorted.at(-1),
    previous = sorted.filter((r) => r.at <= (current?.at ?? 0) - 60).at(-1);
  const baseline = sorted.filter((r) => r.at < now - 120 && r.at >= now - 3600);
  if (!current || !previous || now - current.at > 120 || baseline.length < 30)
    return null;
  const old = sorted.filter((r) => r.at < now - 3600);
  for (const field of ["reserve0", "reserve1"] as const) {
    let base = median(baseline.map((r) => r[field]));
    if (old.length >= 30) {
      const long = median(old.map((r) => r[field]));
      if (long < base) base = long;
    }
    if (base > 0n && current[field] * 2n < base && previous[field] * 2n < base)
      return {
        kind: "LP_RESERVE_LOSS",
        target: pool,
        severity: "soft",
        value: Number(((base - current[field]) * 10000n) / base),
        at: now,
        evidence: `${field}: baseline=${base}; prior=${previous[field]}; current=${current[field]}`,
      };
  }
  return null;
}
export async function scanPool(
  client: PublicClient,
  db: Db,
  repo: Repo,
  pool: Address,
) {
  const block = await client.getBlock();
  if (block.number === null) throw new Error("Mined block required");
  const read = (address: Address, functionName: string, args: unknown[] = []) =>
    client.readContract({
      address,
      abi,
      functionName,
      args,
      blockNumber: block.number,
      gas: 200000n,
    } as never);
  const [token0, token1] = (await Promise.all([
    read(pool, "token0"),
    read(pool, "token1"),
  ])) as Address[];
  const [reserve0, reserve1] = (await Promise.all([
    read(token0!, "balanceOf", [pool]),
    read(token1!, "balanceOf", [pool]),
  ])) as bigint[];
  const now = Number(block.timestamp);
  await db.query(
    "INSERT INTO lp_reserve_snapshots(pool,at,reserve0,reserve1) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [pool.toLowerCase(), now, reserve0!.toString(), reserve1!.toString()],
  );
  const rows = await db.query<{
    at: string;
    reserve0: string;
    reserve1: string;
  }>(
    "SELECT at,reserve0,reserve1 FROM lp_reserve_snapshots WHERE pool=$1 AND at>=$2 ORDER BY at",
    [pool.toLowerCase(), now - 86400],
  );
  const signal = reserveSignal(
    pool,
    rows.map((r) => ({
      at: Number(r.at),
      reserve0: BigInt(r.reserve0),
      reserve1: BigInt(r.reserve1),
    })),
    now,
  );
  if (signal) await repo.recordSignal(signal);
  await db.query("DELETE FROM lp_reserve_snapshots WHERE at<$1", [
    now - 172800,
  ]);
  return signal;
}
