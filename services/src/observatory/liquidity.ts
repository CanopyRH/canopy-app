import type { Address } from "viem";
import { fractionBps, type Observation } from "./core";

export function stressLiquidity(total: bigint | null, idle: bigint | null) {
  return [500, 1000, 2500, 5000, 10000].map((withdrawalBps) => {
    const demand =
      total === null ? null : (total * BigInt(withdrawalBps) + 9999n) / 10000n;
    return {
      withdrawalBps,
      demand,
      idleShortfall:
        demand === null || idle === null
          ? null
          : demand > idle
            ? demand - idle
            : 0n,
    };
  });
}
export async function liquidityLab(
  o: Observation,
  vault: Address,
  owner?: Address,
) {
  const [asset, total, supply] = await Promise.all([
    o.read<Address>(vault, "asset"),
    o.read<bigint>(vault, "totalAssets"),
    o.read<bigint>(vault, "totalSupply"),
  ]);
  const idle = asset ? await o.read<bigint>(asset, "balanceOf", [vault]) : null;
  let position = null;
  if (owner) {
    const [shares, maxWithdraw] = await Promise.all([
      o.read<bigint>(vault, "balanceOf", [owner]),
      o.read<bigint>(vault, "maxWithdraw", [owner]),
    ]);
    const assets =
      shares === null
        ? null
        : await o.read<bigint>(vault, "convertToAssets", [shares]);
    position = {
      owner,
      shares,
      assets,
      maxWithdraw,
      reportedWithdrawableBps:
        assets === null || maxWithdraw === null
          ? null
          : fractionBps(maxWithdraw, assets),
    };
  }
  return o.finish(
    "liquidity",
    {
      vault,
      asset,
      totalAssets: total,
      totalSupply: supply,
      idleAssets: idle,
      idleCoverageBps:
        total === null || idle === null ? null : fractionBps(idle, total),
      position,
      scenarios: stressLiquidity(total, idle),
    },
    [
      "Scenarios compare hypothetical withdrawals with currently idle tokens only; market liquidity, gates, fees and concurrent exits can change the outcome.",
      "maxWithdraw is the vault's report at this block, not a simulated Canopy exit or a guarantee. No transaction is prepared or sent.",
    ],
  );
}
