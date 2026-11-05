import { describe, expect, test } from "bun:test";
// @ts-expect-error plain JS module
import { ago, alarmTitle, duration, paidText, tokenAmount } from "../src/site/exitsFormat.js";

describe("exit log wording", () => {
  test("relative time", () => {
    expect(ago(1000, null)).toBeNull();
    expect(ago(1000, 990)).toBe("just now");
    expect(ago(1000, 1000 - 300)).toBe("5 min ago");
    expect(ago(100000, 100000 - 7200)).toBe("2 h ago");
    expect(ago(1_000_000, 1_000_000 - 86400)).toBe("1 day ago");
    expect(ago(1_000_000, 1_000_000 - 3 * 86400)).toBe("3 days ago");
  });

  test("durations", () => {
    expect(duration(null)).toBeNull();
    expect(duration(0)).toBe("0 s");
    expect(duration(45)).toBe("45 s");
    expect(duration(250)).toBe("4 min 10 s");
    expect(duration(300)).toBe("5 min");
    expect(duration(3900)).toBe("1 h 5 min");
  });

  test("amounts", () => {
    expect(tokenAmount("5000000", 6)).toBe("5");
    expect(tokenAmount("1234567890", 6)).toBe("1,234.5678");
    expect(tokenAmount("1", 6)).toBe("under 0.0001");
    expect(tokenAmount("0", 6)).toBe("0");
    expect(tokenAmount("nope", 6)).toBeNull();
  });

  test("what came back falls back to the token address when the symbol is unknown", () => {
    const token = "0x00000000000000000000000000000000000000d4";
    expect(paidText({ token, amount: "5000000", symbol: "USDG", decimals: 6 }, undefined)).toEqual({ amount: "5", unit: "USDG" });
    expect(paidText({ token, amount: "5000000", symbol: null, decimals: null }, { symbol: "USDG", decimals: 6 })).toEqual({ amount: "5", unit: "USDG" });
    expect(paidText({ token, amount: "5000000", symbol: null, decimals: null }, undefined).unit).toContain("0x0000");
  });

  test("alarm names read as titles", () => {
    expect(alarmTitle("a price alarm")).toBe("Price alarm");
    expect(alarmTitle("an exploit alarm confirmed by watchers")).toBe("Exploit alarm confirmed by watchers");
  });
});
