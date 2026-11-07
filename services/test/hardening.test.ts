import { expect, test } from "bun:test";
import {
  ReportApprovals,
  attributedVaults,
  type ReportScope,
} from "../src/watcher/attribution";
import { drainReadiness } from "../src/risk/drain-reference";
import { armReadiness } from "../src/risk/arm-readiness";
import { maintenanceKeys } from "../src/keeper/maintenance";
import { Kind, keyOf, registrationOrder } from "../src/api/presets";
import { decide } from "../src/engine/decide";
import { checkGovernance } from "../deploy/governance-check";
import { AdapterReview } from "../deploy/enable-adapter";
import type { Address, Hex } from "viem";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const approval = {
  sha256: "a".repeat(64),
  sourceUrl: "https://reports.example/item",
  chainId: 4663,
  targets: [A(1)],
  reviewedAt: 100,
  expiresAt: 200,
};
const scope: ReportScope = {
  chainId: 4663,
  hash: approval.sha256,
  sourceUrl: approval.sourceUrl,
  now: 150,
  approvals: ReportApprovals.parse({ version: 1, reports: [approval] }),
};
const vaults = [
  { name: "Yearn USDG", target: A(1) },
  { name: "Yearn USDG", target: A(2) },
];
test("attribution requires exact chain, source, bytes, time, label and vault address", () => {
  expect(attributedVaults(vaults, "EXPLOIT_CONFIRMED", scope)).toEqual([
    vaults[0]!,
  ]);
  for (const s of [
    undefined,
    { ...scope, chainId: 1 },
    { ...scope, hash: "b".repeat(64) },
    { ...scope, sourceUrl: "https://other.example/item" },
    { ...scope, now: 99 },
    { ...scope, now: 200 },
  ])
    expect(attributedVaults(vaults, "EXPLOIT_CONFIRMED", s)).toEqual([]);
  expect(attributedVaults(vaults, "DEPEG_REPORT", scope)).toEqual([]);
  expect(attributedVaults(vaults, "HARMLESS", scope)).toEqual([]);
  expect(
    attributedVaults(vaults, "EXPLOIT_CONFIRMED", {
      ...scope,
      approvals: { version: 1, reports: [] },
    }),
  ).toEqual([]);
});
test("approval files reject excess trust duration, duplicates, model fields and non-HTTPS sources", () => {
  for (const reports of [
    [{ ...approval, expiresAt: 86501 }],
    [approval, approval],
    [{ ...approval, protocol: "Yearn" }],
    [{ ...approval, sourceUrl: "http://reports.example" }],
  ])
    expect(ReportApprovals.safeParse({ version: 1, reports }).success).toBe(
      false,
    );
});
test("depeg reports plus a drain cannot become exploit confirmation", () => {
  const sig = (kind: string) =>
    ({
      kind,
      severity: "soft",
      target: A(1),
      at: 150,
      evidence: kind,
    }) as never;
  expect(decide([sig("DRAIN"), sig("FEED_DEPEG_REPORT")]).path).toBe("NONE");
  expect(decide([sig("DRAIN"), sig("FEED_EXPLOIT_CONFIRMED")]).path).toBe(
    "ATTEST",
  );
});
test("drain readiness distinguishes missing, partial, stale and current references", () => {
  const s = { snapAt: 5000n, snap: 100n, prevSnap: 100n };
  expect(drainReadiness(s, 3600, 8600n)).toBe("ready");
  expect(drainReadiness(s, 3600, 8601n)).toBe("stale");
  expect(drainReadiness({ ...s, snap: 0n }, 3600, 5000n)).toBe("warming-up");
  expect(drainReadiness({ ...s, prevSnap: 0n }, 3600, 5000n)).toBe(
    "warming-up",
  );
  expect(drainReadiness(s, 3600, 4999n)).toBe("unreadable");
  expect(drainReadiness(s, 1199, 5000n)).toBe("unreadable");
});
test("listed checkpoints are maintained without paid positions; custom scope remains paid/live", async () => {
  let args: unknown[] = [];
  const r = {
    liveKeysOfKind: async (...a: unknown[]) => {
      args = a;
      return [
        H(99),
        keyOf(registrationOrder(A(1)).find((d) => d.kind === Kind.DRAIN)!),
      ];
    },
  };
  const out = await maintenanceKeys(r as never, [A(1)], Kind.DRAIN, 123);
  expect(out).toEqual([
    keyOf(registrationOrder(A(1)).find((d) => d.kind === Kind.DRAIN)!),
    H(99),
  ]);
  expect(args).toEqual([Kind.DRAIN, 123]);
  expect(
    (
      await maintenanceKeys(
        { liveKeysOfKind: async () => [] } as never,
        [A(1)],
        Kind.SHARE_DROP,
      )
    ).length,
  ).toBe(1);
  await expect(
    maintenanceKeys(r as never, [A(1)], Kind.QUORUM),
  ).rejects.toThrow("Unsupported");
});
function readiness(
  opts: {
    cold?: boolean;
    stale?: boolean;
    partBlocked?: boolean;
    unknown?: boolean;
    failed?: boolean;
    nested?: boolean;
  } = {},
) {
  const reads: bigint[] = [];
  const c = {
    getBlock: async () => ({ number: 10n, timestamp: 10000n }),
    readContract: async (p: any) => {
      reads.push(p.blockNumber);
      if (opts.failed) throw Error("RPC");
      if (p.functionName === "state")
        return [
          !opts.unknown,
          0n,
          opts.stale ? 1n : 10000n,
          0n,
          100n,
          0n,
          0n,
          opts.cold ? 0n : 100n,
        ];
      if (p.functionName === "armable")
        return !(opts.partBlocked && p.args[0] === H(2));
      if (p.functionName === "detector")
        return {
          kind:
            p.args[0] === H(1) || opts.nested
              ? Kind.BOTH
              : p.args[0] === H(2)
                ? Kind.DRAIN
                : Kind.QUORUM,
          window: 3600,
          a: H(2),
          b: H(3),
        };
      throw Error("unexpected");
    },
  };
  return { run: () => armReadiness(c as never, A(1), H(1), 10n), reads };
}
test("BOTH readiness checks parts at one mined block, including cold, stale and pending references", async () => {
  const f = readiness();
  expect((await f.run()).armable).toBe(true);
  expect(f.reads.every((n) => n === 10n)).toBe(true);
  for (const opts of [
    { cold: true },
    { stale: true },
    { partBlocked: true },
    { nested: true },
  ])
    expect((await readiness(opts).run()).armable).toBe(false);
  expect((await readiness({ unknown: true }).run()).known).toBe(false);
  await expect(readiness({ failed: true }).run()).rejects.toThrow("RPC");
});
const cfg = {
  chainId: 4663,
  timelock: A(1),
  admin: A(2),
  guardian: A(3),
  payments: A(4),
};
function gov(
  opts: {
    delay?: bigint;
    shared?: boolean;
    threshold?: bigint;
    reorg?: boolean;
    wrongChain?: boolean;
  } = {},
) {
  let blocks = 0;
  return {
    getChainId: async () => (opts.wrongChain ? 1 : 4663),
    getBlock: async () => ({
      number: 10n,
      hash: ++blocks === 2 && opts.reorg ? H(2) : H(1),
    }),
    readContract: async (p: any) => {
      expect(p.blockNumber).toBe(10n);
      if (p.functionName === "DELAY") return opts.delay ?? 604800n;
      if (p.functionName === "PROPOSER") return cfg.admin;
      if (p.functionName === "getThreshold") return opts.threshold ?? 2n;
      const n = opts.shared ? 10 : Number(BigInt(p.address)) * 10;
      return [A(n), A(n + 1), A(n + 2)];
    },
  };
}
test("governance preflight refuses zero delay, shared owners, weak thresholds, wrong chain and reorganized snapshots", async () => {
  expect((await checkGovernance(gov() as never, cfg)).ready).toBe(true);
  for (const o of [{ delay: 0n }, { shared: true }, { threshold: 1n }])
    expect((await checkGovernance(gov(o) as never, cfg)).ready).toBe(false);
  await expect(
    checkGovernance(gov({ wrongChain: true }) as never, cfg),
  ).rejects.toThrow("Wrong RPC");
  await expect(
    checkGovernance(gov({ reorg: true }) as never, cfg),
  ).rejects.toThrow("Snapshot changed");
});
test("adapter approvals require bounded review dates and exact runtime hashes", () => {
  const r = {
    chainId: 4663,
    adapter: A(1),
    runtimeHash: H(1),
    reviewedAt: 100,
    expiresAt: 200,
  };
  expect(AdapterReview.safeParse(r).success).toBe(true);
  for (const bad of [
    { ...r, expiresAt: 100 },
    { ...r, expiresAt: 31 * 86400 },
    { ...r, runtimeHash: "0x00" },
    { ...r, extra: true },
  ])
    expect(AdapterReview.safeParse(bad).success).toBe(false);
});

test("report approval helper hashes exact text without normalization", async () => {
  const { reportApproval } = await import("../deploy/report-approval");
  const a = reportApproval(
      "report",
      approval.sourceUrl,
      4663,
      [A(1)],
      100,
      200,
    ),
    b = reportApproval("report\n", approval.sourceUrl, 4663, [A(1)], 100, 200);
  expect(a.reports[0]!.sha256).not.toBe(b.reports[0]!.sha256);
});
