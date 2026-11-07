import { z } from "zod";
import { getAddress, keccak256, toHex, type Address } from "viem";

/** RH is a separate exchange. Never fall back to Lighter Core on an outage. */
export const LIGHTER_RH = {
  origin: "https://api.rh.lighter.xyz",
  settlementChainId: 4663,
  signingChainId: 466324,
  venue: keccak256(toHex("lighter-rh")),
} as const;
const index = z
  .number()
  .int()
  .min(0)
  .max(2 ** 48 - 1);
const decimal = z.string().regex(/^\d{1,40}(\.\d{1,18})?$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const LighterPosition = z.object({
  market_id: index,
  symbol: z.string().max(40),
  sign: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  position: decimal,
  liquidation_price: decimal,
  allocated_margin: decimal,
  margin_mode: z.number().int(),
  unrealized_pnl: z.string().regex(/^-?\d{1,40}(\.\d{1,18})?$/),
});
export const LighterMarket = z.object({
  market_id: index,
  symbol: z.string().max(40),
  market_type: z.literal("perp"),
  status: z.string(),
  is_frozen: z.boolean(),
  supported_size_decimals: z.number().int().min(0).max(18),
  supported_price_decimals: z.number().int().min(0).max(18),
  min_base_amount: decimal,
  min_quote_amount: decimal,
  mark_price: decimal,
  index_price: decimal,
});
const Account = z.object({
  account_index: index,
  l1_address: address,
  positions: z.array(LighterPosition).max(512),
  status: z.number().int(),
});
const Key = z.object({
  account_index: index,
  api_key_index: z.number().int().min(0).max(254),
  public_key: z.string().regex(/^(0x)?[0-9a-fA-F]{80}$/),
  nonce: z.number().int().nonnegative(),
});
const Ok = z.object({ code: z.literal(200) });
/** Exact fixed-point conversion; never round order size or limits through a float. */
export function units(value: string, decimals: number): bigint {
  decimal.parse(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error("Invalid decimal precision");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals)))
    throw new Error("Amount exceeds market precision");
  return (
    BigInt(whole!) * 10n ** BigInt(decimals) +
    BigInt(fraction.slice(0, decimals).padEnd(decimals, "0") || "0")
  );
}
export function lighterClient(fetcher: typeof fetch = fetch) {
  async function read(path: string, parameters: Record<string, string> = {}) {
    const url = new URL("/api/v1/" + path, LIGHTER_RH.origin);
    for (const [k, v] of Object.entries(parameters)) url.searchParams.set(k, v);
    const r = await fetcher(url, {
      signal: AbortSignal.timeout(8000),
      redirect: "error",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    });
    if (!r.ok || !r.body) throw new Error("Lighter RH unavailable");
    const reader = r.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4_000_000) throw new Error("Lighter response exceeds limit");
        parts.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
    Ok.parse(parsed);
    return parsed;
  }
  return {
    async discover(owner: Address, cursor?: string) {
      getAddress(owner);
      if (cursor !== undefined && (!cursor.length || cursor.length > 512))
        throw new Error("Invalid cursor");
      const data = z
        .object({
          l1_address: address,
          sub_accounts: z
            .array(z.object({ index, l1_address: address }))
            .max(1000),
          next_cursor: z.string().max(512).nullish(),
        })
        .parse(
          await read("accountsByL1Address", {
            l1_address: owner,
            ...(cursor ? { cursor } : {}),
          }),
        );
      if (
        data.l1_address.toLowerCase() !== owner.toLowerCase() ||
        data.sub_accounts.some(
          (a) => a.l1_address.toLowerCase() !== owner.toLowerCase(),
        )
      )
        throw new Error("Account ownership mismatch");
      return {
        accounts: data.sub_accounts.map((a) => a.index),
        nextCursor: data.next_cursor ?? null,
      };
    },
    async account(accountIndex: number, owner: Address) {
      index.parse(accountIndex);
      getAddress(owner);
      const data = z
        .object({ accounts: z.array(Account).max(100) })
        .parse(
          await read("account", { by: "index", value: String(accountIndex) }),
        );
      const a = data.accounts.find((a) => a.account_index === accountIndex);
      if (!a || a.l1_address.toLowerCase() !== owner.toLowerCase())
        throw new Error("Account ownership mismatch");
      return a;
    },
    async markets() {
      return z
        .object({ order_book_details: z.array(LighterMarket).max(2000) })
        .parse(await read("orderBookDetails")).order_book_details;
    },
    async funding() {
      return z.object({ funding_rates: z.array(z.object({
        market_id: index, exchange: z.string().min(1).max(40), symbol: z.string().min(1).max(40),
        rate: z.number().finite().min(-10).max(10),
      })).max(5000) }).parse(await read("funding-rates")).funding_rates;
    },
    async key(accountIndex: number, keyIndex: number, publicKey: string) {
      index.parse(accountIndex);
      z.number().int().min(2).max(254).parse(keyIndex);
      const data = z.object({ api_keys: z.array(Key).max(255) }).parse(
        await read("apikeys", {
          account_index: String(accountIndex),
          api_key_index: String(keyIndex),
        }),
      );
      const key = data.api_keys.find(
        (k) => k.account_index === accountIndex && k.api_key_index === keyIndex,
      );
      if (
        !key ||
        key.public_key.replace(/^0x/, "").toLowerCase() !==
          publicKey.replace(/^0x/, "").toLowerCase()
      )
        throw new Error("Venue key mismatch or revoked");
      // The API schema exposes no scope field. A matching key is not proof of trade-only permissions.
      return { ...key, permissionsVerified: false as const };
    },
  };
}

export const LighterOrder = z.object({
  owner_account_index: index,
  market_index: index,
  client_order_index: index,
  order_id: z.string().min(1).max(120),
  is_ask: z.boolean(),
  reduce_only: z.literal(true),
  time_in_force: z.literal("immediate-or-cancel"),
  status: z.string(),
  filled_base_amount: decimal,
  filled_quote_amount: decimal,
  initial_base_amount: decimal,
  remaining_base_amount: decimal,
  transaction_time: z.number().int().nonnegative(),
  block_height: z.number().int().nonnegative(),
});
/** Only terminal, account-bound venue order records establish receipts. Submission acknowledgements never do. */
export function confirmedFill(
  raw: unknown,
  expected: {
    account: number;
    market: number;
    clientOrder: number;
    ask: boolean;
    size: bigint;
    sizeDecimals: number;
    quoteDecimals: number;
    limitPrice: bigint;
    priceDecimals: number;
  },
) {
  for (const n of [
    expected.sizeDecimals,
    expected.quoteDecimals,
    expected.priceDecimals,
  ])
    if (!Number.isInteger(n) || n < 0 || n > 18)
      throw new Error("Invalid fill precision");
  if (expected.size <= 0n || expected.limitPrice <= 0n)
    throw new Error("Invalid expected order");
  const o = LighterOrder.parse(raw);
  if (
    o.owner_account_index !== expected.account ||
    o.market_index !== expected.market ||
    o.client_order_index !== expected.clientOrder ||
    o.is_ask !== expected.ask
  )
    throw new Error("Fill identity mismatch");
  if (!["filled", "canceled", "expired"].includes(o.status)) return null;
  const size = units(o.filled_base_amount, expected.sizeDecimals),
    quote = units(o.filled_quote_amount, expected.quoteDecimals),
    initial = units(o.initial_base_amount, expected.sizeDecimals),
    remaining = units(o.remaining_base_amount, expected.sizeDecimals);
  if (
    initial !== expected.size ||
    size > initial ||
    size + remaining > initial ||
    o.block_height === 0
  )
    throw new Error("Invalid fill amounts or confirmation");
  if (size === 0n) {
    if (quote !== 0n) throw new Error("Quote without filled size");
    return {
      status: "unfilled" as const,
      size: 0n,
      quote: 0n,
      orderId: o.order_id,
    };
  }
  if (quote === 0n || o.transaction_time === 0)
    throw new Error("Incomplete fill");
  const actual =
      quote * 10n ** BigInt(expected.sizeDecimals + expected.priceDecimals),
    limit = expected.limitPrice * size * 10n ** BigInt(expected.quoteDecimals);
  if (expected.ask ? actual < limit : actual > limit)
    throw new Error("Fill outside price limit");
  return {
    status: size === initial ? ("filled" as const) : ("partial" as const),
    size,
    quote,
    orderId: o.order_id,
    block: o.block_height,
    transactionTime: o.transaction_time,
    receiptHash: keccak256(toHex(JSON.stringify(o))),
  };
}
