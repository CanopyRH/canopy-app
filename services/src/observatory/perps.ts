import type { Address } from "viem";
import {
  lighterClient,
  LIGHTER_RH,
  units,
  type LighterMarket,
  type LighterPosition,
} from "../perps/lighter";
import type { z } from "zod";

export function marketRisk(m: z.infer<typeof LighterMarket>) {
  const mark = units(m.mark_price, 18),
    reference = units(m.index_price, 18);
  return {
    marketId: m.market_id,
    symbol: m.symbol,
    mark: m.mark_price,
    reference: m.index_price,
    status: m.status,
    frozen: m.is_frozen,
    gapBps:
      reference > 0n && mark > 0n
        ? (((mark - reference) * 10000n) / reference).toString()
        : null,
    sourceState:
      reference <= 0n || mark <= 0n
        ? "invalid-price"
        : m.is_frozen || m.status !== "active"
          ? "market-unavailable"
          : "market-reported-active",
  };
}
export function positionRisk(
  p: z.infer<typeof LighterPosition>,
  m?: z.infer<typeof LighterMarket>,
) {
  const mark = m ? units(m.mark_price, 18) : 0n,
    liquidation = units(p.liquidation_price, 18);
  const distance =
    mark > 0n && liquidation > 0n && p.sign !== 0
      ? ((p.sign === 1 ? mark - liquidation : liquidation - mark) * 10000n) /
        mark
      : null;
  return {
    marketId: p.market_id,
    symbol: p.symbol,
    direction: p.sign,
    size: p.position,
    liquidationPrice: p.liquidation_price,
    distanceBps: distance?.toString() ?? null,
    atOrBeyondReportedLiquidation: distance === null ? null : distance <= 0n,
    market: m ? marketRisk(m) : null,
  };
}
export async function perpsRadar(
  io = lighterClient(),
  owner?: Address,
  account?: number,
  now?: number,
) {
  const markets = await io.markets();
  const a =
    owner !== undefined && account !== undefined
      ? await io.account(account, owner)
      : null;
  return {
    version: 1,
    feature: "perps",
    chainId: LIGHTER_RH.settlementChainId,
    observedAt: {
      receivedAt: now ?? Math.floor(Date.now() / 1000),
      source: LIGHTER_RH.origin,
    },
    data: {
      owner: owner ?? null,
      account: account ?? null,
      accountStatus: a?.status ?? null,
      markets: markets.map(marketRisk),
      positions: a
        ? a.positions
            .filter((p) => units(p.position, 18) > 0n)
            .map((p) =>
              positionRisk(
                p,
                markets.find((m) => m.market_id === p.market_id),
              ),
            )
        : [],
    },
    limitations: [
      "Venue-reported observations, not cryptographic proofs or liquidation predictions. The response does not supply a market observation timestamp.",
      "Market and account responses are separate observations. Funding, cross-margin changes and pending orders can alter liquidation. No keys, orders or execution.",
    ],
  };
}
