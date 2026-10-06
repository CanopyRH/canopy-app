import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData, recoverAddress, type Address, type Hex } from "viem";
import { drainVelocity, feedSignal, governance, paused, shareDrop, type Signal } from "../src/detectors";
import { decide } from "../src/engine/decide";
import { buildPrompt, parseClassification } from "../src/engine/llmClassify";
import { assembleQuorum, attestDomain, attestTypes, canonicalJson, evidenceHash, signAttest } from "../src/watcher/attest";
import { judge, sizeExit } from "../src/keeper/simulate";
import { daysFor, extendPlan, keeperShouldRun } from "../src/billing/prepaid";
import { alarmAlert, WELCOME } from "../src/copy/alerts";
import { findBanned } from "../../tools/banned-words";

const T = "0x0000000000000000000000000000000000000001" as const;
const sig = (kind: string, severity: "hard" | "soft"): Signal => ({ kind, target: T, severity, value: 1, at: 1, evidence: "e" });

describe("detectors", () => {
  test("drain fires only above the threshold", () => {
    const s = [{ t: 0, totalAssets: 1000n }, { t: 100, totalAssets: 700n }];
    expect(drainVelocity(s, 3600, 2500n, T)?.severity).toBe("soft");
    expect(drainVelocity(s, 3600, 3000n, T)).toBeNull();
  });

  test("drain ignores peaks outside the window and short series", () => {
    expect(drainVelocity([{ t: 0, totalAssets: 1000n }, { t: 10_000, totalAssets: 100n }], 3600, 2500n, T)).toBeNull();
    expect(drainVelocity([{ t: 0, totalAssets: 1000n }], 3600, 2500n, T)).toBeNull();
    expect(drainVelocity([{ t: 0, totalAssets: 0n }, { t: 1, totalAssets: 0n }], 3600, 1n, T)).toBeNull();
  });

  test("share drop is hard, with exact edges", () => {
    expect(shareDrop(1_000_000n, 994_999n, 50n, T, 1)?.severity).toBe("hard");
    expect(shareDrop(1_000_000n, 995_000n, 50n, T, 1)).toBeNull();
    expect(shareDrop(0n, 1n, 50n, T, 1)).toBeNull();
  });

  test("governance matches listed events only", () => {
    expect(governance("SetCurator(address)", T, 1, "d")?.severity).toBe("soft");
    expect(governance("Transfer(address,address,uint256)", T, 1, "d")).toBeNull();
  });

  test("pause is hard", () => {
    expect(paused(true, T, 1)?.severity).toBe("hard");
    expect(paused(false, T, 1)).toBeNull();
  });
});
