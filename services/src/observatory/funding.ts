import { lighterClient, LIGHTER_RH } from "../perps/lighter";
export async function fundingWatch(io = lighterClient(), now?: number) {
  const rates = await io.funding();
  return {
    version: 1,
    feature: "funding",
    chainId: LIGHTER_RH.settlementChainId,
    observedAt: {
      receivedAt: now ?? Math.floor(Date.now() / 1000),
      source: LIGHTER_RH.origin,
    },
    data: {
      rates: rates
        .map((r) => ({
          marketId: r.market_id,
          symbol: r.symbol,
          venue: r.exchange,
          rate: r.rate,
        }))
        .sort(
          (a, b) =>
            a.symbol.localeCompare(b.symbol) || a.venue.localeCompare(b.venue),
        ),
      venues: [...new Set(rates.map((r) => r.exchange))].sort(),
    },
    limitations: [
      "Cross-venue reference rates from Lighter's funding-rates endpoint. Every row retains its venue; market IDs must not be treated as RH position IDs.",
      "This endpoint supplies neither a rate timestamp nor comparable funding intervals. No annualized yield, payment forecast or live Lighter-rate claim is made.",
    ],
  };
}
