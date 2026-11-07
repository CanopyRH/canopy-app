import { test, expect } from "bun:test";
import {
  lighterClient,
  units,
  confirmedFill,
  LIGHTER_RH,
} from "../src/perps/lighter";
const owner = "0x1111111111111111111111111111111111111111";
const fixture = (data: unknown) =>
  (async (input: RequestInfo | URL) => {
    expect(new URL(String(input)).origin).toBe(LIGHTER_RH.origin);
    return Response.json(data);
  }) as typeof fetch;
test("RH discovery binds every account to the requested owner and uses exact units", async () => {
  expect(
    await lighterClient(
      fixture({
        code: 200,
        l1_address: owner,
        sub_accounts: [{ index: 23, l1_address: owner }],
      }),
    ).discover(owner),
  ).toEqual({ accounts: [23], nextCursor: null });
  await expect(
    lighterClient(
      fixture({
        code: 200,
        l1_address: owner,
        sub_accounts: [
          {
            index: 23,
            l1_address: "0x2222222222222222222222222222222222222222",
          },
        ],
      }),
    ).discover(owner),
  ).rejects.toThrow();
  expect(units("9007199254740993.001", 3)).toBe(9007199254740993001n);
  expect(() => units("1.001", 2)).toThrow();
});
test("matching API key is explicitly not evidence of restricted permissions", async () => {
  const k = "ab".repeat(40);
  const c = lighterClient(
    fixture({
      code: 200,
      api_keys: [
        { account_index: 23, api_key_index: 2, public_key: k, nonce: 1 },
      ],
    }),
  );
  expect((await c.key(23, 2, k)).permissionsVerified).toBe(false);
  await expect(c.key(23, 1, k)).rejects.toThrow();
  await expect(c.key(23, 2, "cd".repeat(40))).rejects.toThrow();
});
const order = {
  owner_account_index: 23,
  market_index: 2,
  client_order_index: 17,
  order_id: "abc",
  is_ask: true,
  reduce_only: true,
  time_in_force: "immediate-or-cancel",
  status: "filled",
  filled_base_amount: "2",
  filled_quote_amount: "200",
  initial_base_amount: "2",
  remaining_base_amount: "0",
  transaction_time: 1000,
  block_height: 45,
};
const expected = {
  account: 23,
  market: 2,
  clientOrder: 17,
  ask: true,
  size: 200n,
  sizeDecimals: 2,
  quoteDecimals: 2,
  limitPrice: 9900n,
  priceDecimals: 2,
};
test("receipts require terminal matching reduce-only fills at the limit", () => {
  expect(confirmedFill(order, expected)?.status).toBe("filled");
  expect(confirmedFill({ ...order, status: "open" }, expected)).toBeNull();
  for (const patch of [
    { owner_account_index: 24 },
    { client_order_index: 18 },
    { reduce_only: false },
    { filled_base_amount: "3" },
    { filled_quote_amount: "190" },
    { time_in_force: "good-till-time" },
    { block_height: 0 },
  ])
    expect(() => confirmedFill({ ...order, ...patch }, expected)).toThrow();
  expect(
    confirmedFill(
      {
        ...order,
        status: "canceled",
        filled_base_amount: "1",
        filled_quote_amount: "100",
        remaining_base_amount: "1",
      },
      expected,
    )?.status,
  ).toBe("partial");
  expect(
    confirmedFill(
      {
        ...order,
        status: "canceled",
        filled_base_amount: "0",
        filled_quote_amount: "0",
        remaining_base_amount: "2",
      },
      expected,
    )?.status,
  ).toBe("unfilled");
});
