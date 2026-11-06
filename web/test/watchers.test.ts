import { describe, expect, test } from "bun:test";
import { ago, countsLine, parseReport, shortAddress, utc, watchersUrl } from "../src/watchers";

const A = "0xabababababababababababababababababababab";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const NOW = 2_000_000_000;

const attestation = { key: hash(1), evidence: hash(2), attestedAt: NOW - 120, deadline: NOW + 600, firedAt: NOW - 100, matched: true };
const watcher = { address: A, source: "chain", status: "active", activeFrom: NOW - 86_400, expiresAt: NOW + 86_400 * 300, approvedAt: NOW - 86_400, lastAttestedAt: NOW - 120, attestations30d: 3, matched30d: 1, recent: [attestation] };
const report = { windowDays: 30, generatedAt: NOW, watchers: [watcher] };

describe("reading /watchers", () => {
  test("accepts what the API sends", () => {
    expect(parseReport(report)).toEqual(report as never);
  });

  test("accepts a watcher that has never signed", () => {
    const fresh = { ...watcher, source: "config", status: "listed", activeFrom: null, expiresAt: null, approvedAt: null, lastAttestedAt: null, attestations30d: 0, matched30d: 0, recent: [] };
    expect(parseReport({ ...report, watchers: [fresh] })?.watchers[0]).toEqual(fresh as never);
  });

  test("refuses anything that is not a report", () => {
    for (const bad of [null, undefined, "x", 4, [], {}, { ...report, watchers: "no" }, { ...report, windowDays: "30" }, { ...report, generatedAt: -1 }]) {
      expect(parseReport(bad)).toBeNull();
    }
  });

  test("drops a malformed watcher or signature instead of showing it half-true", () => {
    const bad = [
      { ...watcher, address: "0x12" },
      { ...watcher, source: "somewhere" },
      { ...watcher, attestations30d: "3" },
      { ...watcher, lastAttestedAt: undefined },
      { ...watcher, recent: "x" },
    ];
    expect(parseReport({ ...report, watchers: [...bad, watcher] })?.watchers).toEqual([watcher] as never);
    const row = parseReport({ ...report, watchers: [{ ...watcher, recent: [attestation, { ...attestation, key: "0x1" }, { ...attestation, matched: "yes" }] }] })!.watchers[0]!;
    expect(row.recent).toEqual([attestation]);
  });

  test("keeps markup as plain text: nothing here is ever rendered as HTML", () => {
    const sneaky = { ...watcher, address: "<img src=x onerror=alert(1)>" };
    expect(parseReport({ ...report, watchers: [sneaky] })?.watchers).toEqual([]);
  });
});

describe("how the page says it", () => {
  test("times", () => {
    expect(ago(NOW, null)).toBe("never");
    expect(ago(NOW, NOW - 5)).toBe("just now");
    expect(ago(NOW, NOW + 50)).toBe("just now"); // a clock a little ahead
    expect(ago(NOW, NOW - 60)).toBe("1 minute ago");
    expect(ago(NOW, NOW - 59 * 60)).toBe("59 minutes ago");
    expect(ago(NOW, NOW - 3600)).toBe("1 hour ago");
    expect(ago(NOW, NOW - 3 * 86_400 - 5)).toBe("3 days ago");
    expect(utc(1_793_000_000)).toBe("2026-10-26 07:33 UTC");
  });

  test("counts", () => {
    expect(countsLine({ attestations30d: 0, matched30d: 0 }, 30)).toBe("No signatures in the last 30 days");
    expect(countsLine({ attestations30d: 1, matched30d: 0 }, 30)).toBe("1 signature, 0 of them matched an alarm that fired");
    expect(countsLine({ attestations30d: 7, matched30d: 2 }, 30)).toBe("7 signatures, 2 of them matched an alarm that fired");
  });

  test("addresses and the API url", () => {
    expect(shortAddress(A)).toBe("0xabab…abab");
    expect(watchersUrl("https://api.example.com")).toBe("https://api.example.com/watchers");
    expect(watchersUrl("https://api.example.com/")).toBe("https://api.example.com/watchers");
    expect(watchersUrl("")).toBe("/watchers");
  });
});
