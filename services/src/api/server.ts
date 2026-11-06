import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { isAddress, type Address, type Hex } from "viem";
import { presetsFor } from "./presets";
import type { Db } from "../store/db";
import type { Repo } from "../store/repo";
import { acceptAttestation } from "../watcher/watcher";
import { PLUGINS, type Plugin } from "../plugins";
import { sameSecret } from "./secret";
import { DEFAULT_RATE_LIMIT, bucketOf, clientIp, rateLimit, type RateLimit } from "./ratelimit";

const AttestBody = z.strictObject({
  key: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  evidence: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  deadline: z.string().regex(/^\d{1,20}$/),
  signer: z.string().refine((a) => isAddress(a)),
  sig: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

const MAX_BODY = 64 * 1024;
/** Alarms per page of /alarms/live. A caller that sends no limit gets this many, which is every alarm on any normal day. */
export const ALARMS_PAGE = 1_000;

export interface ApiDeps {
  db: Db;
  repo: Repo;
  vaults: () => Promise<{ address: Address; name: string; chainId: number; asset: string }[]>;
  /** Alarms of the last day, newest first, a page at a time. */
  liveAlarms: (page: { limit: number; before?: { firedAt: number; key: string } }) => Promise<{ key: string; fired_at: number }[]>;
  watchers: Address[];
  alarmBook: Address;
  chainId: number;
  now: () => number;
  onAttested?: (key: Hex, evidence: Hex, deadline: bigint) => Promise<void>;
  telegram?: (update: unknown) => Promise<void>;
  telegramSecret?: string;
  health?: () => Promise<unknown>;
  healthToken?: string;
  /** Reads allowed per address per minute, and how many proxies to trust. Defaults to 120 and one proxy. */
  rateLimit?: RateLimit;
  /** Feature routes. Defaults to the files in src/plugins/. */
  plugins?: Plugin[];
}

/** Read-only API. No route accepts a wallet or a wallet list, and none sets a user cookie. */
export function createApi(d: ApiDeps) {
  const app = new Hono();
  // The web app is hosted elsewhere, including IPFS. Nothing here is private, and it sends no credentials.
  app.use("/*", cors({ origin: "*", allowMethods: ["GET"] }));
  // Every public read, plugin routes included, shares one per-address limit. The token-guarded health check is left out so a
  // monitor is never turned away, and the POST routes have their own checks.
  app.use("/*", rateLimit(d.rateLimit ?? DEFAULT_RATE_LIMIT, d.now, (path) => path === "/health"));
  const small = bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "too large" }, 413) });
  const vaultParam = (t: string) => (isAddress(t) ? (t as Address) : null);

  app.get("/vaults", async (c) => c.json(await d.vaults()));
  // Still a plain array, so callers that never page see what they always did. A full page names the next one in a header.
  app.get("/alarms/live", async (c) => {
    const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "", 10) || ALARMS_PAGE, 1), ALARMS_PAGE);
    const cursor = /^(\d{1,12}):(0x[0-9a-fA-F]{64})$/.exec(c.req.query("before") ?? "");
    if (c.req.query("before") !== undefined && !cursor) return c.json({ error: "bad cursor" }, 400);
    const rows = await d.liveAlarms({ limit, before: cursor ? { firedAt: Number(cursor[1]), key: cursor[2]! } : undefined });
    const last = rows[rows.length - 1];
    if (rows.length === limit && last) c.header("X-Next-Before", `${last.fired_at}:${last.key}`);
    return c.json(rows);
  });
  app.get("/health", async (c) => {
    if (!d.health || !d.healthToken || !sameSecret(c.req.header("authorization"), `Bearer ${d.healthToken}`)) return c.json({ error: "forbidden" }, 403);
    // Who the API thinks is asking, so an operator can check the proxy settings the read limit relies on.
    const limit = d.rateLimit ?? DEFAULT_RATE_LIMIT;
    const caller = { forwardedFor: c.req.header("x-forwarded-for") ?? null, realIp: c.req.header("x-real-ip") ?? null, countedAs: bucketOf(clientIp(c, limit.proxyHops)) };
    return c.json({ ...((await d.health()) as object), caller });
  });
  app.get("/risk/:target", async (c) => {
    const t = vaultParam(c.req.param("target"));
    if (!t) return c.json({ error: "bad address" }, 400);
    const card = await d.repo.card(t.toLowerCase());
    return card ? c.json(card) : c.json({ error: "unknown vault" }, 404);
  });
  app.get("/presets/:target", (c) => {
    const t = vaultParam(c.req.param("target"));
    if (!t) return c.json({ error: "bad address" }, 400);
    const out = presetsFor(t).map((p) => ({ name: p.name, note: p.note, key: p.key, detector: { ...p.detector, threshold: p.detector.threshold.toString() } }));
    return c.json(out);
  });
  app.post("/watcher/attest", small, async (c) => {
    const parsed = AttestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad body" }, 400);
    const b = parsed.data;
    const a = { key: b.key as Hex, evidence: b.evidence as Hex, deadline: BigInt(b.deadline), signer: b.signer as Address, sig: b.sig as Hex };
    let ok = false;
    try {
      ok = await acceptAttestation(d.db, d.watchers, d.alarmBook, d.chainId, a, d.now());
    } catch {
      ok = false;
    }
    if (!ok) return c.json({ error: "rejected" }, 403);
    await d.onAttested?.(a.key, a.evidence, a.deadline);
    return c.json({ ok: true });
  });
  app.post("/tg/webhook", small, async (c) => {
    if (!d.telegram || !d.telegramSecret || !sameSecret(c.req.header("x-telegram-bot-api-secret-token"), d.telegramSecret)) {
      return c.json({ error: "forbidden" }, 403);
    }
    await d.telegram(await c.req.json());
    return c.json({ ok: true });
  });
  for (const p of d.plugins ?? PLUGINS) p.api?.(app, d);
  return app;
}
