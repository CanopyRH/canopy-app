import { isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";

export interface RateLimit {
  /** Reads allowed per client address in one minute. 0 turns the limit off. */
  perMin: number;
  /**
   * How many proxies sit in front of this service and add to X-Forwarded-For. Each proxy appends the address it saw, so the
   * client is the entry that many places from the end; anything a caller put in front of it is ignored. 0 trusts no header
   * and uses the connection's own address.
   */
  proxyHops: number;
}

export const DEFAULT_RATE_LIMIT: RateLimit = { perMin: 120, proxyHops: 1 };

const WINDOW_SEC = 60;
/** Addresses tracked at once. Past this, the oldest windows are dropped, so a flood of addresses can't grow memory without bound. */
const MAX_TRACKED = 20_000;

const tidy = (ip: string) => {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return (v4 ? v4[1]! : ip).toLowerCase();
};

/**
 * The /64 an IPv6 address belongs to, such as "2001:db8:1:2::/64". One host is usually given a whole /64, so counting
 * each address alone would give it 2^64 fresh buckets. Anything that isn't IPv6 is returned as it is.
 */
export function bucketOf(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  let s = ip.toLowerCase().split("%")[0]!;
  // A trailing dotted quad, as in 64:ff9b::192.0.2.1, is the last two groups.
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (quad) {
    const o = quad.slice(1).map(Number);
    s = `${s.slice(0, -quad[0].length)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const [head, tail] = s.includes("::") ? (s.split("::") as [string, string]) : [s, undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":")}::/64`;
}

/** The caller's address from X-Forwarded-For, counting `hops` proxies from the end. Null if the header can't be trusted. */
export function forwardedClient(header: string | undefined, hops: number): string | null {
  if (!header || hops < 1) return null;
  const parts = header.split(",").map((p) => p.trim()).filter(Boolean);
  const ip = parts.length >= hops ? parts[parts.length - hops] : undefined;
  return ip && isIP(ip) ? tidy(ip) : null;
}

/** The address of the TCP connection, which behind a proxy is the proxy itself. Bun passes its server as the context's env. */
function socketIp(c: Context): string | null {
  try {
    const env = c.env as { requestIP?: (r: Request) => { address: string } | null; server?: { requestIP?: (r: Request) => { address: string } | null } } | undefined;
    const server = env?.requestIP ? env : env?.server;
    const info = server?.requestIP?.(c.req.raw);
    return info?.address ? tidy(info.address) : null;
  } catch {
    return null;
  }
}

/** Who is asking. Without a usable header or connection address, everyone shares one bucket named "unknown". */
export const clientIp = (c: Context, proxyHops: number) => forwardedClient(c.req.header("x-forwarded-for"), proxyHops) ?? socketIp(c) ?? "unknown";

/**
 * A per-address limit on the public read routes: `perMin` reads in a fixed one-minute window, then 429 with Retry-After.
 * Kept in memory, so each process counts alone. That is enough to stop one address hammering the database-backed routes.
 */
export function rateLimit(limit: RateLimit, now: () => number, skip: (path: string) => boolean = () => false): MiddlewareHandler {
  const windows = new Map<string, { start: number; count: number }>();
  const sweep = (t: number) => {
    for (const [k, w] of windows) if (t - w.start >= WINDOW_SEC) windows.delete(k);
    // Still full of live windows: drop the oldest, which are first in insertion order.
    for (const k of windows.keys()) {
      if (windows.size < MAX_TRACKED) break;
      windows.delete(k);
    }
  };
  return async (c, next) => {
    const method = c.req.method;
    if (limit.perMin <= 0 || (method !== "GET" && method !== "HEAD") || skip(c.req.path)) return next();
    const t = now();
    // IPv6 callers are counted by /64, the block one host is normally given.
    const ip = bucketOf(clientIp(c, limit.proxyHops));
    let w = windows.get(ip);
    if (!w || t - w.start >= WINDOW_SEC) {
      if (!w && windows.size >= MAX_TRACKED) sweep(t);
      w = { start: t, count: 0 };
      windows.delete(ip);
      windows.set(ip, w);
    }
    w.count++;
    if (w.count > limit.perMin) {
      c.header("Retry-After", String(Math.max(1, WINDOW_SEC - (t - w.start))));
      return c.json({ error: "too many requests" }, 429);
    }
    return next();
  };
}
