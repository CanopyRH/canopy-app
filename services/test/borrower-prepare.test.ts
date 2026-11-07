import { test, expect } from "bun:test";
import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
import { prepareBorrowRepayment } from "../src/borrower/prepare";
import { ExpansionRequest } from "../src/expansion-cli";
const a = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const params = [a(5), a(6), a(7), a(0), 800000000000000000n] as const;
const market = keccak256(
  encodeAbiParameters(
    parseAbiParameters("address,address,address,address,uint256"),
    params,
  ),
);
const config = {
  chainId: 4663,
  guard: a(1),
  owner: a(2),
  morpho: a(3),
  alarmBook: a(4),
  market,
  health: a(8),
};
const policy = {
  triggerLtvBps: 7000,
  targetLtvBps: 6000,
  sessionTargetLtvBps: 4000,
  preCloseSeconds: 600,
  maxObservationAge: 30,
};
function fixture() {
  const calls: any[] = [];
  let live = true,
    wrong = false,
    fail = false;
  const client = {
    getChainId: async () => 4663,
    getBlock: async () => ({ number: 123n, timestamp: 1000n }),
    readContract: async (p: any) => {
      calls.push(p);
      const data: Record<string, unknown> = {
        OWNER: wrong ? a(9) : config.owner,
        MORPHO: config.morpho,
        ALARM_BOOK: config.alarmBook,
        MARKET_ID: market,
        active: true,
        expiresAt: 2000n,
        withdrawShareBps: 0,
        remainingBudget: 500n,
        keys: [market],
        isLive: live,
        idToMarketParams: params,
        market: [1000n, 1000000000n, 750n, 750000000n, 1000n, 0n],
        position: [0n, 750000000n, 1000n],
        price: 10n ** 36n,
        value: 2n,
        allowance: 500n,
        balanceOf: 500n,
      };
      if (!(p.functionName in data)) throw Error("unexpected read");
      return data[p.functionName];
    },
    simulateContract: async (p: any) => {
      calls.push(p);
      if (fail) throw Error("simulation reverted");
      return { result: [151n, 0n] };
    },
  };
  return {
    client: client as never,
    calls,
    setLive: (v: boolean) => (live = v),
    setWrong: () => (wrong = true),
    setFail: () => (fail = true),
  };
}
test("borrow preparation binds owner/market and simulates exact unsigned repayment at one block", async () => {
  const f = fixture();
  const result = await prepareBorrowRepayment(
    f.client,
    config,
    a(9),
    policy,
    undefined,
    1000,
  );
  expect(result.plan).toMatchObject({ action: "repay", requested: 151n });
  expect(result.transaction).toMatchObject({
    chainId: 4663,
    to: config.guard,
    from: a(9),
    value: 0n,
  });
  expect(f.calls.every((p) => p.blockNumber === 123n)).toBe(true);
  expect(f.calls.at(-1).args).toEqual([151n, market]);
  f.setWrong();
  await expect(
    prepareBorrowRepayment(f.client, config, a(9), policy, undefined, 1000),
  ).rejects.toThrow("owner-reviewed");
});
test("no alarm produces no transaction and simulation failures cannot produce calldata", async () => {
  const f = fixture();
  f.setLive(false);
  expect(
    (
      await prepareBorrowRepayment(
        f.client,
        config,
        a(9),
        policy,
        undefined,
        1000,
      )
    ).transaction,
  ).toBeNull();
  expect(f.calls.some((p) => p.functionName === "repay")).toBe(false);
  f.setLive(true);
  f.setFail();
  await expect(
    prepareBorrowRepayment(f.client, config, a(9), policy, undefined, 1000),
  ).rejects.toThrow("simulation reverted");
});
test("operator request rejects signing keys, unknown fields and unbounded market lists", () => {
  expect(
    ExpansionRequest.safeParse({
      command: "exposure",
      chainId: 4663,
      root: a(1),
      privateKey: "no",
    }).success,
  ).toBe(false);
  expect(
    ExpansionRequest.safeParse({
      command: "borrow-discover",
      chainId: 4663,
      morpho: a(1),
      owner: a(2),
      markets: Array(65).fill({ id: market, health: a(3) }),
    }).success,
  ).toBe(false);
  expect(
    ExpansionRequest.safeParse({
      command: "lighter-account",
      account: 1,
      owner: a(2),
    }).success,
  ).toBe(true);
});

test("preparation refuses a stale or future chain head", async () => {
  const f = fixture();
  await expect(
    prepareBorrowRepayment(f.client, config, a(9), policy, undefined, 1031),
  ).rejects.toThrow("chain head");
  await expect(
    prepareBorrowRepayment(f.client, config, a(9), policy, undefined, 990),
  ).rejects.toThrow("chain head");
});
