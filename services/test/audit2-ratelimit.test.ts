// Audit 2 PoC A2-L2: the read limit counts each full IPv6 address separately.
// One host holds a whole /64 (2^64 addresses), so it gets a fresh bucket per request. The X-Forwarded-For handling
// itself is right: with one proxy, a forged entry in front of the proxy's own is ignored (checked below too).
// Run: bun test test/audit2-ratelimit.test.ts
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { rateLimit } from "../src/api/ratelimit";

function app(perMin: number) {
  const a = new Hono();
  a.use("/*", rateLimit({ perMin, proxyHops: 1 }, () => 1_000));
  a.get("/risk/:t", (c) => c.json({ ok: true }));
  return a;
}
// What the one trusted proxy forwards: whatever the caller sent, then the address the proxy saw.
const via = (a: Hono, seen: string, forged?: string) =>
  a.fetch(new Request("https://api.example.test/risk/0x01", { headers: { "x-forwarded-for": forged ? `${forged}, ${seen}` : seen } }));

describe("A2-L2: per-address read limit", () => {
  test("control: one address is cut off after perMin reads, and a forged leading entry doesn't help", async () => {
    const a = app(120);
    let ok = 0;
    for (let i = 0; i < 200; i++) if ((await via(a, "203.0.113.7", `198.51.100.${i % 250}`)).status === 200) ok++;
    expect(ok).toBe(120);
  });

  test("one IPv6 host rotating through its own /64 is never limited", async () => {
    const a = app(120);
    let ok = 0;
    for (let i = 0; i < 2_000; i++) if ((await via(a, `2001:db8:1:2::${i.toString(16)}`)).status === 200) ok++;
    console.log(`A2-L2: ${ok} of 2000 reads from one /64 answered at a limit of 120 per minute`);
    expect(ok).toBe(2_000);
  });
});
