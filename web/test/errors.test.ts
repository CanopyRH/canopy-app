import { describe, expect, test } from "bun:test";
import { encodeErrorResult, type Address, type Hex } from "viem";
import { COPY } from "../src/copy/text";
import { contractErrorsAbi, revertText } from "../src/errors";
import { friendly } from "../src/wallet";
import { findBanned } from "../../tools/banned-words";
import { routerAbi as compiled } from "../../services/src/chain/abi.generated";

const A = "0x00000000000000000000000000000000000000a2" as Address;
const K = `0x${"22".repeat(32)}` as Hex;

const data = (name: string, args?: readonly unknown[]) => encodeErrorResult({ abi: contractErrorsAbi, errorName: name, args } as never);

describe("contract errors in plain words", () => {
  test("every error the app explains exists in the compiled router with the same arguments", () => {
    const compiledErrors = compiled.filter((x) => x.type === "error").map((x) => `${x.name}(${(x.inputs as readonly { type: string }[]).map((i) => i.type).join(",")})`);
    for (const item of contractErrorsAbi) expect(compiledErrors).toContain(`${item.name}(${item.inputs.map((i) => i.type).join(",")})`);
  });

  test("AlarmNotClear reads as the alarm being off limits, from raw revert data in any usual place", () => {
    const d = data("AlarmNotClear", [K]);
    expect(revertText({ data: d })).toBe(COPY.errAlarmNotClear);
    expect(revertText({ error: { data: d } })).toBe(COPY.errAlarmNotClear);
    expect(revertText({ cause: { cause: { data: { data: d } } } })).toBe(COPY.errAlarmNotClear);
    expect(friendly(Object.assign(new Error("Execution reverted for an unknown reason."), { data: d }))).toBe(COPY.errAlarmNotClear);
    expect(COPY.errAlarmNotClear).toContain("That alarm is going off or can't be read right now, so it can't protect a new position");
  });

  test("a wallet that prints the error's name is understood too", () => {
    expect(friendly(new Error("execution reverted: custom error AlarmNotClear(0x2222)"))).toBe(COPY.errAlarmNotClear);
    expect(friendly(new Error("reverted with custom error 'SwapsNeedStableHarbour()'"))).toBe(COPY.errSwapsNeedStable);
  });

  test("each new error has its own sentence", () => {
    expect(revertText({ data: data("SwapsNeedStableHarbour") })).toBe(COPY.errSwapsNeedStable);
    expect(revertText({ data: data("TooManySwaps") })).toBe(COPY.errTooManySwaps);
    expect(revertText({ data: data("DuplicateSwap", [A]) })).toBe(COPY.errDuplicateSwap);
    expect(revertText({ data: data("ArmingIsPaused") })).toBe(COPY.errArmingPaused);
    expect(revertText({ data: data("TooManyKeys") })).toBe(COPY.errTooManyKeys);
  });

  test("other errors, and data that is not an error, fall through", () => {
    expect(revertText({ data: `0x08c379a0${"00".repeat(64)}` })).toBeNull();
    expect(revertText(new Error("nonce too low"))).toBeNull();
    expect(revertText(null)).toBeNull();
    expect(friendly(new Error("nonce too low"))).toBe("nonce too low");
  });

  test("a rejection in the wallet is still a rejection", () => {
    expect(friendly({ code: 4001, message: "User rejected the request." })).toBe(COPY.txRejected);
  });

  test("the sentences are short enough for the wallet error line and carry no banned words", () => {
    const lines = Object.entries(COPY).filter(([k]) => k.startsWith("err")).map(([, v]) => v as string);
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const l of lines) {
      expect(l.length).toBeLessThan(160);
      expect(findBanned(l)).toEqual([]);
    }
  });
});
