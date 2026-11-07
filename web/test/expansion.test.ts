import { expect, test } from "bun:test";
import { decodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import { CONFIG, type Chain } from "../src/config";
import { stablePayout, validRoute, type ReviewedRoute } from "../src/stableExit";
import { lpNetwork, lpPositionId, lpAbi, rangeState } from "../src/lp";
import type { Net, Signer } from "../src/chain";
import { routerAbi } from "../../services/src/chain/abi.generated";

const token = "0x0000000000000000000000000000000000000001" as Address;
const stable = "0x0000000000000000000000000000000000000002" as Address;
const feed = "0x0000000000000000000000000000000000000003" as Address;
const owner = "0x0000000000000000000000000000000000000004" as Address;
const adapter = "0x0000000000000000000000000000000000000005" as Address;
const txHash = ("0x" + "ab".repeat(32)) as Hex;
const route: ReviewedRoute = { token, feed, heartbeat: 3600, tokenDecimals: 18, path: `${token}0001f4${stable.slice(2)}`, reviewUrl: "https://canopy.invalid/reviews/example", reviewedAt: "2026-11-06" };

test("stable payout cannot use unreviewed, ambiguous, reversed or oversized routes", () => {
  const c = { planToken: stable, stableRoutes: [route] };
  expect(stablePayout(c, [token, stable])?.swaps).toEqual([{ token, feed, heartbeat: 3600, tokenDecimals: 18, path: route.path }]);
  expect(stablePayout({ ...c, stableRoutes: [] }, [token])).toBeNull();
  expect(stablePayout({ ...c, stableRoutes: [route, route] }, [token])).toBeNull();
  expect(validRoute({ ...route, reviewUrl: "" }, stable)).toBe(false);
  expect(validRoute({ ...route, feed: zeroAddress }, stable)).toBe(false);
  expect(validRoute({ ...route, path: `${stable}0001f4${token.slice(2)}` }, stable)).toBe(false);
  expect(validRoute({ ...route, heartbeat: 172801 }, stable)).toBe(false);
  expect(validRoute({ ...route, path: `${token}000000${stable.slice(2)}` }, stable)).toBe(false);
  expect(() => stablePayout(c, [token], 101)).toThrow();
});
test("an asset already in the payout stablecoin needs no swap or route", () => {
  expect(stablePayout({ planToken: stable }, [stable])).toEqual({ harbour: 1, maxSlipBps: 100, swaps: [] });
});
test("LP range boundaries follow Uniswap's lower-inclusive upper-exclusive ticks", () => {
  expect(rangeState(-10, -10, 10)).toBe("In range");
  expect(rangeState(10, -10, 10)).toBe("Out of range");
  expect(lpPositionId(owner, adapter, token, 1n)).not.toBe(lpPositionId(owner, adapter, token, 2n));
});

function fixture(opts: { noAdapter?: boolean; allowed?: boolean; holder?: Address; failRead?: boolean; total?: bigint } = {}) {
  const c: Chain = { ...CONFIG, lp: { positionManager: token, adapter: opts.noAdapter ? null : adapter } };
  const sends: { to: Address; data: Hex }[] = [];
  const reads: string[] = [];
  const client = {
    getChainId: async () => c.chainId,
    getBlockNumber: async () => 100n,
    getBlock: async () => ({ timestamp: 1000000n }),
    readContract: async (p: { functionName: string; args?: unknown[] }) => {
      reads.push(p.functionName);
      if (opts.failRead && p.functionName === "positions") throw new Error("offline");
      switch (p.functionName) {
        case "balanceOf": return opts.total ?? 1n;
        case "tokenOfOwnerByIndex": return BigInt(p.args![1] as bigint) + 1n;
        case "ownerOf": return opts.holder ?? owner;
        case "positions": return [0n, zeroAddress, token, stable, 500, -10, 10, 1000n, 0n, 0n, 1n, 2n];
        case "factory": case "getPool": return feed;
        case "slot0": return [1n, 0, 0, 0, 0, 0, true];
        case "symbol": return "TOKEN";
        case "isArmed": case "isApprovedForAll": case "check": return false;
        case "ROUTER": return c.router;
        case "POSITIONS": return token;
        case "adapterAllowed": return opts.allowed ?? true;
        case "state": return [true, 0n, 0n, 0n, 0n, 0n, 0n, 0n];
        case "armable": return true;
        case "getApproved": return zeroAddress;
        default: throw new Error(p.functionName);
      }
    },
    call: async () => ({ data: "0x" }),
    waitForTransactionReceipt: async () => ({ status: "success" }),
  };
  const signer: Signer = { account: owner, onConfirm: () => {}, provider: { request: async (req) => {
    if (req.method === "eth_chainId") return c.chainHex;
    if (req.method === "eth_sendTransaction") { sends.push(req.params![0] as never); return txHash; }
    throw new Error(req.method);
  } } };
  return { lp: lpNetwork(c, { client } as unknown as Net), c, signer, sends, reads };
}
test("LP reads are paginated and a failed NFT read is reported rather than hidden", async () => {
  const f = fixture({ total: 15n });
  const page = await f.lp.scan(owner);
  expect(page.positions.length).toBe(12); expect(page.next).toBe(12);
  const rest = await f.lp.scan(owner, 12);
  expect(rest.positions.length).toBe(3); expect(rest.next).toBeNull();
  const failed = await fixture({ failRead: true }).lp.scan(owner);
  expect(failed.failed).toBe(true); expect(failed.positions).toEqual([]);
});
test("LP arming refuses a missing/disallowed adapter and another owner's NFT before sending", async () => {
  for (const opts of [{ noAdapter: true }, { allowed: false }, { holder: feed }]) {
    const f = fixture(opts);
    await expect(f.lp.arm(f.signer, 1n, "raw")).rejects.toThrow();
    expect(f.sends).toEqual([]);
  }
});
test("LP arming approves only the selected NFT, then binds its owner position and quorum", async () => {
  const f = fixture();
  await f.lp.arm(f.signer, 7n, "raw");
  expect(f.sends.length).toBe(2);
  const approval = decodeFunctionData({ abi: lpAbi, data: f.sends[0]!.data });
  expect(approval.functionName).toBe("approve");
  expect(approval.args?.[1]).toBe(7n);
  const arm = decodeFunctionData({ abi: routerAbi, data: f.sends[1]!.data });
  expect(arm.functionName).toBe("arm");
  expect(arm.args![0]).toMatchObject({ target: token, adapter, tokenId: 7n, harbour: 0, swaps: [] });
});
test("LP stable conversion is blocked before any approval when a route is missing", async () => {
  const f = fixture();
  await expect(f.lp.arm(f.signer, 7n, "stable")).rejects.toThrow("routes are missing");
  expect(f.sends).toEqual([]);
});
