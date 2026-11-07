import { test, expect } from "bun:test";
import { Calendar, sessionState } from "../src/rwa/session";
import { lookThrough } from "../src/risk/lookthrough";
import { explainExposure } from "../src/copilot/explain";
const root = "0x0000000000000000000000000000000000000001",
  token = "0x0000000000000000000000000000000000000002";
const calendar = Calendar.parse({
  source: "https://example.com/reviewed-calendar",
  reviewedAt: 1,
  validFrom: 100,
  validUntil: 500,
  windows: [
    { open: 110, close: 200 },
    { open: 300, close: 400 },
  ],
});
const feed = { updatedAt: 190, heartbeat: 60, positive: true, paused: false };
test("session closes exactly at boundary; stale, unknown and multiplier events hold swaps", () => {
  expect(sessionState(calendar, 199, 10, feed)).toMatchObject({
    state: "open",
    allowSwap: true,
    preClose: true,
  });
  expect(sessionState(calendar, 200, 10, feed)).toMatchObject({
    state: "closed",
    allowSwap: false,
  });
  expect(sessionState(calendar, 500, 10, feed).state).toBe("unknown");
  expect(sessionState(calendar, 310, 10, feed).allowSwap).toBe(false);
  expect(
    sessionState(calendar, 199, 10, { ...feed, paused: null }).allowSwap,
  ).toBe(false);
  expect(sessionState(calendar, 199, 10, feed, true).allowSwap).toBe(false);
  expect(
    sessionState(calendar, 199, 10, { ...feed, updatedAt: 200 }).allowSwap,
  ).toBe(false);
  expect(() =>
    Calendar.parse({
      ...calendar,
      windows: [
        { open: 110, close: 200 },
        { open: 190, close: 300 },
      ],
    }),
  ).toThrow();
});
test("look-through preserves unknown reads and a single block; cycles are bounded", async () => {
  const blocks: bigint[] = [];
  const client = {
    readContract: async (p: any) => {
      blocks.push(p.blockNumber);
      if (p.functionName === "asset") return p.address === root ? token : root;
      throw Error("unsupported");
    },
  };
  const graph = await lookThrough(client as never, root, 123n);
  expect(graph.nodes.length).toBe(2);
  expect(graph.edges.some((e) => e.cycle)).toBe(true);
  expect(blocks.every((b) => b === 123n)).toBe(true);
  expect(explainExposure(graph).join(" ")).toContain("unknown");
  expect(graph.nodes[0]?.markets).toEqual([]);
});
test("V2 dependencies are listed without pretending allocations were read", async () => {
  const client = {
    readContract: async (p: any) => {
      if (p.address === token) throw Error();
      if (p.functionName === "asset") return token;
      if (p.functionName === "adaptersLength") return 100n;
      if (p.functionName === "adapters") return token;
      throw Error();
    },
  };
  const graph = await lookThrough(client as never, root, 123n);
  expect(graph.truncated).toBe(true);
  expect(graph.nodes[0]?.adapters).toHaveLength(1);
  expect(explainExposure(graph).join(" ")).toContain("weights remain unknown");
});

test("V2 compatible allocations are parent-bound, deduplicated and described with their accounting", async () => {
  const adapter = "0x0000000000000000000000000000000000000003";
  const core = "0x0000000000000000000000000000000000000004";
  const id = `0x${"ab".repeat(32)}`;
  let wrongParent = false;
  const client = {
    readContract: async (p: any) => {
      if (p.address === root) {
        if (p.functionName === "asset") return token;
        if (p.functionName === "adaptersLength") return 2n;
        if (p.functionName === "adapters") return adapter;
      }
      if (p.address === adapter) {
        if (p.functionName === "parentVault") return wrongParent ? token : root;
        if (p.functionName === "morpho") return core;
        if (p.functionName === "marketIdsLength") return 2n;
        if (p.functionName === "marketIds") return id;
        if (p.functionName === "expectedSupplyAssets") return 250n;
      }
      if (p.address === core) {
        if (p.functionName === "idToMarketParams")
          return [token, token, token, token, 800000000000000000n];
        if (p.functionName === "market")
          return [1000n, 1000000000n, 750n, 750000000n, 100n, 0n];
      }
      throw Error("unsupported");
    },
  };
  const graph = await lookThrough(client as never, root, 123n);
  expect(graph.nodes[0]?.markets).toHaveLength(1);
  expect(graph.nodes[0]?.markets[0]).toMatchObject({
    allocationAssets: "250",
    accounting: "expected-adapter-assets",
    utilizationBps: "7500",
  });
  expect(explainExposure(graph).join(" ")).toContain("adapter expected assets");
  wrongParent = true;
  const rejected = await lookThrough(client as never, root, 123n);
  expect(rejected.nodes[0]?.markets).toHaveLength(0);
  expect(rejected.nodes[0]?.unknown.join(" ")).toContain(
    "unsupported allocation",
  );
});
