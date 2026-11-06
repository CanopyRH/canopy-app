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

const AttestBody = z.strictObject({
  key: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  evidence: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  deadline: z.string().regex(/^\d{1,20}$/),
  signer: z.string().refine((a) => isAddress(a)),
  sig: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

const MAX_BODY = 64 * 1024;

export interface ApiDeps {
  db: Db;
  repo: Repo;
  vaults: () => Promise<{ address: Address; name: string; chainId: number; asset: string }[]>;
  liveAlarms: () => Promise<unknown[]>;
  watchers: Address[];
  alarmBook: Address;
  chainId: number;
  now: () => number;
  onAttested?: (key: Hex, evidence: Hex, deadline: bigint) => Promise<void>;
  telegram?: (update: unknown) => Promise<void>;
  telegramSecret?: string;
  health?: () => Promise<unknown>;
  healthToken?: string;
  /** Feature routes. Defaults to the files in src/plugins/. */
  plugins?: Plugin[];
}

/** Read-only API. No route accepts a wallet or a wallet list, and none sets a user cookie. */
export function createApi(d: ApiDeps) {
  const app = new Hono();
  // The web app is hosted elsewhere, including IPFS. Nothing here is private, and it sends no credentials.
  app.use("/*", cors({ origin: "*", allowMethods: ["GET"] }));
  const small = bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "too large" }, 413) });
  const vaultParam = (t: string) => (isAddress(t) ? (t as Address) : null);

  app.get("/vaults", async (c) => c.json(await d.vaults()));
  app.get("/alarms/live", async (c) => c.json(await d.liveAlarms()));
  app.get("/health", async (c) => {
    if (!d.health || !d.healthToken || !sameSecret(c.req.header("authorization"), `Bearer ${d.healthToken}`)) return c.json({ error: "forbidden" }, 403);
    return c.json(await d.health());
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
