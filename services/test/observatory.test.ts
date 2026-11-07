import { fundingWatch } from "../src/observatory/funding";
import { describe, expect, test } from "bun:test";
import {
  keccak256,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { observe, serial } from "../src/observatory/core";
import { oracleLens } from "../src/observatory/oracles";
import {
  controlMap,
  slotAddress,
  PROXY_SLOTS,
} from "../src/observatory/controls";
import { concentrationOf } from "../src/observatory/concentration";
import { liquidityLab, stressLiquidity } from "../src/observatory/liquidity";
import { marketRisk, positionRisk, perpsRadar } from "../src/observatory/perps";
import { sessionPlan, sessionIcs } from "../src/observatory/sessions";
import { verifyEvidence } from "../src/observatory/evidence";
import { heartbeatTyped, verifyHeartbeat } from "../src/observatory/heartbeat";
import { compareReports } from "../src/observatory/changes";
import { canonicalJson, signAttest } from "../src/watcher/attest";
import { createResearch } from "../src/observatory";
import type { ExposureGraph } from "../src/risk/lookthrough";
const A = (x: number) => `0x${x.toString(16).padStart(40, "0")}` as Address;
const H = (x: number) => `0x${x.toString(16).padStart(64, "0")}` as Hex;
const V = A(1),
  ASSET = A(2),
  OWNER = A(3),
  ORACLE = A(4),
  FEED = A(5),
  BOOK = A(6),
  COLLATERAL = A(7),
  MORPHO = A(8),
  IRM = A(9);
const now = 1000;
function rpc(
  over: {
    chain?: number;
    timestamp?: bigint;
    reorg?: boolean;
    failed?: string;
    code?: Hex;
    impl?: Hex;
  } = {},
) {
  const reads: any[] = [];
  let heads = 0;
  const client = {
    getChainId: async () => over.chain ?? 4663,
    getBlock: async () => ({
      number: 100n,
      hash: ++heads > 1 && over.reorg ? H(2) : H(1),
      timestamp: over.timestamp ?? 1000n,
    }),
    getCode: async (p: any) => {
      reads.push(p);
      return over.code ?? "0x6000";
    },
    getStorageAt: async (p: any) => {
      reads.push(p);
      return p.slot === PROXY_SLOTS.implementation ? (over.impl ?? H(0)) : H(0);
    },
    readContract: async (p: any) => {
      reads.push(p);
      const { address: a, functionName: f, args = [] } = p;
      if (f === over.failed)
        throw new Error("https://rpc.invalid/secret-credential");
      if (a === V) {
        switch (f) {
          case "asset":
            return ASSET;
          case "owner":
          case "curator":
            return OWNER;
          case "guardian":
            return zeroAddress;
          case "MORPHO":
            return MORPHO;
          case "withdrawQueueLength":
            return 1n;
          case "withdrawQueue":
            return H(10);
          case "totalAssets":
            return 1000n;
          case "totalSupply":
            return 1000n;
          case "balanceOf":
            return 100n;
          case "convertToAssets":
            return args[0];
          case "maxWithdraw":
            return 25n;
        }
      }
      if (a === ASSET && f === "balanceOf") return 100n;
      if (a === MORPHO) {
        if (f === "idToMarketParams")
          return [ASSET, COLLATERAL, ORACLE, IRM, 800000000000000000n];
        if (f === "market") return [1000n, 1000000000n, 500n, 500n, 900n, 0n];
        if (f === "position") return [1000000000n, 0n, 0n];
      }
      if (a === ORACLE) {
        if (f === "price") return 10n ** 36n;
        if (f === "SCALE_FACTOR") return 1n;
        if (f === "BASE_FEED_1") return FEED;
        if (
          [
            "BASE_FEED_2",
            "QUOTE_FEED_1",
            "QUOTE_FEED_2",
            "BASE_VAULT",
            "QUOTE_VAULT",
          ].includes(f)
        )
          return zeroAddress;
      }
      if (a === FEED) {
        if (f === "latestRoundData") return [1n, 100000000n, 900n, 900n, 1n];
        if (f === "decimals") return 8;
        if (f === "description") return "Example price feed";
      }
      throw new Error("Unsupported interface");
    },
  } as unknown as PublicClient;
  return { client, reads };
}
describe("observation boundaries", () => {
  test("rejects the wrong chain, stale and future heads", async () => {
    for (const over of [{ chain: 1 }, { timestamp: 1n }, { timestamp: 1100n }])
      await expect(observe(rpc(over).client, 4663, now)).rejects.toThrow();
  });
  test("pins all reads and rejects a reorganization before returning", async () => {
    const f = rpc({ reorg: true });
    const o = await observe(f.client, 4663, now);
    await expect(liquidityLab(o, V, OWNER)).rejects.toThrow("changed");
    expect(f.reads.every((r) => r.blockNumber === 100n)).toBe(true);
  });
  test("bounds optional reads and never leaks provider errors", async () => {
    const f = rpc({ failed: "totalAssets" }),
      o = await observe(f.client, 4663, now);
    const result = await liquidityLab(o, V);
    expect(result.data.totalAssets).toBeNull();
    expect(JSON.stringify(result)).not.toContain("secret-credential");
    await Promise.all(Array.from({ length: 200 }, () => o.read(V, "owner")));
    expect(f.reads.length).toBeLessThanOrEqual(160);
  });
  test("does not allow arbitrary vaults through the provider", async () => {
    await expect(
      createResearch(rpc().client, {
        chainId: 4663,
        vaults: [V],
        now: () => now,
      })("controls", { vault: A(99) }),
    ).rejects.toThrow("listed");
    await expect(
      createResearch(rpc().client, { chainId: 8453, vaults: [V] })(
        "funding",
        {},
      ),
    ).rejects.toThrow("Robinhood");
  });
});
describe("Oracle Lens", () => {
  test("discovers an oracle and reads its sources at the same block without certifying freshness", async () => {
    const f = rpc(),
      r = await oracleLens(await observe(f.client, 4663, now), V);
    expect(r.data.oracles.length).toBe(1);
    expect(r.data.oracles[0].price).toBe((10n ** 36n).toString());
    expect(r.data.oracles[0].feeds[0]).toMatchObject({
      ageSeconds: "100",
      state: "round-readable",
      freshness: "heartbeat-not-reviewed",
    });
    expect(f.reads.every((r) => r.blockNumber === 100n)).toBe(true);
  });
  test("failed feed rounds stay unknown, never fresh", async () => {
    const r = await oracleLens(
      await observe(rpc({ failed: "latestRoundData" }).client, 4663, now),
      V,
    );
    expect(r.data.oracles[0].feeds[0]).toMatchObject({
      state: "unknown",
      answer: null,
      ageSeconds: null,
    });
  });
});
describe("Control Map", () => {
  test("validates slot encoding and distinguishes no code from a verified EOA", async () => {
    expect(slotAddress(`0x${"ff".repeat(32)}`)).toBeNull();
    expect(slotAddress(null)).toBeNull();
    expect(slotAddress("0x")).toBe(zeroAddress);
    const r = await controlMap(
      await observe(rpc({ code: "0x" }).client, 4663, now),
      V,
    );
    expect(r.data.controls[0].kind).toBe("no-code-at-block");
  });
  test("recognizes delegation while keeping proxy and implementation hashes distinct", async () => {
    const code = `0xef0100${A(19).slice(2)}` as Hex;
    const r = await controlMap(
      await observe(rpc({ code }).client, 4663, now),
      V,
    );
    expect(r.data.controls[0].delegation).toBe(A(19));
    expect(r.data.controls[0].kind).toBe("delegated-code");
    expect(r.data.controls[0].codeHash).toBe(keccak256(code));
  });
});
describe("Exposure Concentration", () => {
  test("groups known root allocations by dependency without adding nested assets", () => {
    const market = (allocationAssets: string, oracle = ORACLE) => ({
      id: H(10),
      collateral: COLLATERAL,
      oracle,
      irm: IRM,
      lltv: "1",
      allocationAssets,
      utilizationBps: null,
      lastAccrual: "0",
    });
    const graph = {
      blockNumber: 100n,
      nodes: [
        {
          address: V,
          asset: ASSET,
          depth: 0,
          roles: {},
          adapters: [],
          markets: [market("30"), market("70", A(11))],
          unknown: ["Incomplete queue"],
        },
        {
          address: COLLATERAL,
          asset: A(40),
          depth: 1,
          roles: {},
          adapters: [],
          markets: [market("999999")],
          unknown: [],
        },
      ],
      edges: [],
      truncated: true,
      coverage: "bounded",
    } satisfies ExposureGraph;
    const r = concentrationOf(graph, V);
    expect(r.knownAllocation).toBe("100");
    expect(r.collateral[0]?.shareOfKnownBps).toBe("10000");
    expect(r.oracle[0]?.shareOfKnownBps).toBe("7000");
    expect(r.truncated).toBe(true);
    expect(r.unknown).toContain("Incomplete queue");
  });
  test("zero and unreadable allocation produce no invented weights", () => {
    const r = concentrationOf(
      { blockNumber: 1n, nodes: [], edges: [], truncated: true, coverage: "" },
      V,
    );
    expect(r.collateral).toEqual([]);
    expect(r.unknown).toContain("Root vault unavailable");
  });
});
describe("Liquidity Stress Lab", () => {
  test("ceil-rounds scenario demand and retains exact amounts larger than JS numbers", () => {
    expect(stressLiquidity(1n, 0n)[0]?.demand).toBe(1n);
    const big = 10n ** 30n + 1n;
    expect(stressLiquidity(big, 0n).at(-1)?.idleShortfall).toBe(big);
    expect(stressLiquidity(null, 0n)[0]?.idleShortfall).toBeNull();
    expect(stressLiquidity(100n, null)[0]?.idleShortfall).toBeNull();
  });
  test("reports owner liquidity separately from idle stress", async () => {
    const r = await liquidityLab(
      await observe(rpc().client, 4663, now),
      V,
      OWNER,
    );
    expect(r.data.position.reportedWithdrawableBps).toBe("2500");
    expect(r.data.scenarios[2].idleShortfall).toBe("150");
  });
});
const market = {
  market_id: 1,
  symbol: "TEST",
  market_type: "perp",
  status: "active",
  is_frozen: false,
  supported_size_decimals: 6,
  supported_price_decimals: 6,
  min_base_amount: "1",
  min_quote_amount: "1",
  mark_price: "100",
  index_price: "101",
} as const;
const position = {
  market_id: 1,
  symbol: "TEST",
  sign: 1,
  position: "1",
  liquidation_price: "80",
  allocated_margin: "10",
  margin_mode: 0,
  unrealized_pnl: "0",
} as const;
describe("Perps Radar", () => {
  test("handles long, short, crossed and absent liquidation prices", () => {
    expect(positionRisk(position, market).distanceBps).toBe("2000");
    expect(
      positionRisk({ ...position, sign: -1, liquidation_price: "120" }, market)
        .distanceBps,
    ).toBe("2000");
    expect(
      positionRisk({ ...position, liquidation_price: "110" }, market)
        .atOrBeyondReportedLiquidation,
    ).toBe(true);
    expect(
      positionRisk({ ...position, liquidation_price: "0" }, market).distanceBps,
    ).toBeNull();
    expect(positionRisk(position).distanceBps).toBeNull();
    expect(marketRisk({ ...market, index_price: "0" }).gapBps).toBeNull();
    expect(marketRisk({ ...market, is_frozen: true }).sourceState).toBe(
      "market-unavailable",
    );
  });
  test("requires the venue adapter to verify account ownership", async () => {
    const io = {
      markets: async () => [market],
      account: async () => {
        throw new Error("Account ownership mismatch");
      },
    } as any;
    await expect(perpsRadar(io, OWNER, 1, now)).rejects.toThrow("ownership");
  });
});
describe("Funding Watch", () => {
  test("keeps venue labels and never annualizes unlike intervals", async () => {
    const r = await fundingWatch(
      {
        funding: async () => [
          { market_id: 1, symbol: "TEST", exchange: "binance", rate: 0.001 },
          { market_id: 1, symbol: "TEST", exchange: "lighter", rate: -0.002 },
        ],
      } as any,
      now,
    );
    expect(r.data.venues).toEqual(["binance", "lighter"]);
    expect(r.data.rates.map((r) => r.rate)).toEqual([0.001, -0.002]);
    expect(JSON.stringify(r)).not.toContain("annualizedYield");
    expect(r.observedAt.receivedAt).toBe(now);
  });
});
const session = {
  calendar: {
    source: "https://example.test/calendar",
    reviewedAt: 900,
    validFrom: 900,
    validUntil: 2000,
    windows: [{ open: 1000, close: 1500 }],
  },
  preCloseSeconds: 600,
  feed: { updatedAt: 990, heartbeat: 60, positive: true, paused: false },
  multiplierChanged: false,
};
describe("Session Planner", () => {
  test("distinguishes covered closure, expiry, stale feeds and preclose", () => {
    expect(sessionPlan(session, 1000).data).toMatchObject({
      state: "open",
      preClose: true,
      allowSwap: true,
    });
    expect(sessionPlan(session, 1600).data.state).toBe("closed");
    expect(sessionPlan(session, 2000).data.state).toBe("unknown");
    expect(
      sessionPlan({ ...session, feed: { ...session.feed, paused: null } }, 1000)
        .data.allowSwap,
    ).toBe(false);
    expect(
      sessionPlan({ ...session, multiplierChanged: true }, 1000).data.allowSwap,
    ).toBe(false);
  });
  test("rejects overlaps and exports bounded UTC calendar reminders", () => {
    expect(() =>
      sessionPlan(
        {
          ...session,
          calendar: {
            ...session.calendar,
            windows: [
              { open: 1000, close: 1500 },
              { open: 1400, close: 1600 },
            ],
          },
        },
        1000,
      ),
    ).toThrow();
    const ics = sessionIcs(session);
    expect(ics).toContain("BEGIN:VCALENDAR\r\n");
    expect(ics).toContain("DTSTART:19700101T001640Z");
    expect(ics).not.toContain("TZID");
  });
});
const signer = privateKeyToAccount(`0x${"31".repeat(32)}`);
async function evidence() {
  const key = H(33),
    signals = [
      {
        kind: "FEED_EXPLOIT_CONFIRMED",
        target: V,
        severity: "soft",
        value: 1,
        at: 990,
        evidence: "report-hash",
      },
    ];
  const e = keccak256(stringToHex(canonicalJson([key, ["report-hash"]])));
  return {
    version: 1,
    chainId: 4663,
    alarmBook: BOOK,
    observedAt: 990,
    signals,
    attestation: {
      key,
      evidence: e,
      deadline: "1100",
      signer: signer.address,
      sig: await signAttest(signer, BOOK, 4663, key, e, 1100n),
    },
  };
}
describe("Evidence Verifier", () => {
  test("checks signature, expected domain, approval and only the fields actually signed", async () => {
    const b = await evidence(),
      expected = { chainId: 4663, alarmBook: BOOK, approved: [signer.address] };
    expect((await verifyEvidence(b, expected, now)).data.consistent).toBe(true);
    b.signals[0]!.evidence = "tampered";
    expect((await verifyEvidence(b, expected, now)).data.evidenceMatches).toBe(
      false,
    );
  });
  test("rejects unapproved, expired, wrong-domain and forged reports", async () => {
    const b = await evidence();
    expect(
      (
        await verifyEvidence(
          b,
          { chainId: 1, alarmBook: BOOK, approved: [] },
          1200,
        )
      ).data.consistent,
    ).toBe(false);
    b.attestation.key = H(34);
    expect(
      (
        await verifyEvidence(
          b,
          { chainId: 4663, alarmBook: BOOK, approved: [signer.address] },
          now,
        )
      ).data.signatureValid,
    ).toBe(false);
  });
});
describe("Agent Liveness", () => {
  test("accepts fresh signed scopes and rejects replay, changed identity, expiry and forged scope", async () => {
    const base = {
      chainId: 4663,
      alarmBook: BOOK,
      agent: signer.address,
      scope: H(4),
      sequence: "2",
      issuedAt: 990,
      expiresAt: 1100,
    };
    const b = {
      ...base,
      signature: await signer.signTypedData(heartbeatTyped(base)),
    };
    const expected = {
      chainId: 4663,
      alarmBook: BOOK,
      agent: signer.address,
      scope: H(4),
      lastSequence: "1",
    };
    expect((await verifyHeartbeat(b, expected, now)).data.state).toBe(
      "recent-signed-heartbeat",
    );
    expect(
      (await verifyHeartbeat(b, { ...expected, lastSequence: "2" }, now)).data
        .state,
    ).toBe("replayed");
    expect((await verifyHeartbeat(b, expected, 1100)).data.state).toBe(
      "expired-or-future",
    );
    expect(
      (await verifyHeartbeat({ ...b, scope: H(5) }, expected, now)).data.state,
    ).toBe("invalid");
    expect(
      (await verifyHeartbeat(b, { ...expected, agent: OWNER }, now)).data.state,
    ).toBe("invalid");
  });
  test("refuses oversized TTL and integer overflow", async () => {
    const b = {
      chainId: 4663,
      alarmBook: BOOK,
      agent: signer.address,
      scope: H(4),
      sequence: "18446744073709551616",
      issuedAt: 1,
      expiresAt: 99999,
      signature: `0x${"00".repeat(65)}`,
    };
    await expect(
      verifyHeartbeat(
        b,
        {
          chainId: 4663,
          alarmBook: BOOK,
          agent: signer.address,
          scope: H(4),
          lastSequence: null,
        },
        now,
      ),
    ).rejects.toThrow();
  });
});
const report = (
  block = "1",
  hash = H(1),
  data: any = { vault: V, value: "10" },
) => ({
  version: 1,
  feature: "controls",
  chainId: 4663,
  observedAt: { block, hash },
  data,
  limitations: [],
});
describe("Change Monitor", () => {
  test("compares compatible subjects while preserving integer strings", () => {
    const r = compareReports(
      report(),
      report("2", H(2), { vault: V, value: "100000000000000000000000" }),
    );
    expect(r.data.changes).toEqual([
      { path: "/data/value", before: "10", after: "100000000000000000000000" },
    ]);
  });
  test("rejects different subjects, chains, backward blocks and same-height reorgs", () => {
    for (const b of [
      report("2", H(2), { vault: OWNER }),
      { ...report(), chainId: 1 },
      report("0"),
      report("1", H(2)),
    ])
      expect(() => compareReports(report(), b)).toThrow();
  });
  test("bounds malicious imports and output size", () => {
    expect(() =>
      compareReports(
        report(),
        report("2", H(2), { value: "x".repeat(2_000_001) }),
      ),
    ).toThrow();
    const r = compareReports(
      report(),
      report("2", H(2), {
        vault: V,
        ...Object.fromEntries(
          Array.from({ length: 500 }, (_, i) => ["key" + i, i]),
        ),
      }),
    );
    expect(r.data.changes.length).toBe(200);
    expect(r.data.truncated).toBe(true);
  });
});

test("Change Monitor rejects different nested liquidity owners", () => {
  const a = {
    ...report(),
    feature: "liquidity",
    data: { vault: V, position: { owner: V } },
  };
  expect(() =>
    compareReports(a, { ...a, data: { vault: V, position: { owner: OWNER } } }),
  ).toThrow("owners");
});
