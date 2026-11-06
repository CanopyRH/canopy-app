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
    const ip = clientIp(c, limit.proxyHops);
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
