// The per-address read limit and IPv6. One host is normally given a whole /64 (2^64 addresses), so counting each
// address alone gave it a fresh bucket per request. Callers are now counted by /64. The X-Forwarded-For handling itself
// was right: with one proxy, a forged entry in front of the proxy's own is ignored (checked below too).
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { bucketOf, rateLimit } from "../src/api/ratelimit";

function app(perMin: number) {
  const a = new Hono();
  a.use("/*", rateLimit({ perMin, proxyHops: 1 }, () => 1_000));
  a.get("/risk/:t", (c) => c.json({ ok: true }));
  return a;
}
// What the one trusted proxy forwards: whatever the caller sent, then the address the proxy saw.
const via = (a: Hono, seen: string, forged?: string) =>
  a.fetch(new Request("https://api.example.test/risk/0x01", { headers: { "x-forwarded-for": forged ? `${forged}, ${seen}` : seen } }));

describe("per-address read limit", () => {
  test("one IPv4 address is cut off after perMin reads, and a forged leading entry doesn't help", async () => {
    const a = app(120);
    let ok = 0;
    for (let i = 0; i < 200; i++) if ((await via(a, "203.0.113.7", `198.51.100.${i % 250}`)).status === 200) ok++;
    expect(ok).toBe(120);
  });

  test("one IPv6 host rotating through its own /64 shares one bucket", async () => {
    const a = app(120);
    let ok = 0;
    for (let i = 0; i < 2_000; i++) if ((await via(a, `2001:db8:1:2::${i.toString(16)}`)).status === 200) ok++;
    // Before: all 2,000 answered.
    expect(ok).toBe(120);
  });

  test("different /64s are different callers", async () => {
    const a = app(1);
    expect((await via(a, "2001:db8:1:2::1")).status).toBe(200);
    expect((await via(a, "2001:db8:1:3::1")).status).toBe(200);
    expect((await via(a, "2001:db8:1:2:ffff::9")).status).toBe(429);
  });

  test("every way of writing an IPv6 address lands in its /64", () => {
    expect(bucketOf("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(bucketOf("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(bucketOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(bucketOf("::1")).toBe("0:0:0:0::/64");
    expect(bucketOf("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    expect(bucketOf("203.0.113.7")).toBe("203.0.113.7");
    expect(bucketOf("unknown")).toBe("unknown");
  });
});
