import type { Context, Hono } from "hono";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { ApiDeps } from "../api/server";
import { DEFAULT_RATE_LIMIT } from "../api/ratelimit";
import { MAX_KEYS, approveCall, armCall, disarmAllCall, exitCall, refusedKeys } from "../api/calldata";
import { buildLlmsTxt } from "../api/llms";
import { buildOpenApi } from "../api/spec";
import type { Plugin } from "../plugins";

/**
 * What an agent builder needs: the OpenAPI description, the llms.txt brief and keyless calldata helpers. Everything here is
 * a read. Nothing signs, nothing stores the addresses it is asked about and nothing accepts a recipient.
 */

const KEY = /^0x[0-9a-fA-F]{64}$/;
const SHORT_CACHE = "public, max-age=300";

const bad = (c: Context, error: string, code = "bad_request") => c.json({ error, code }, 400);

/**
 * The query must hold exactly the named parameters, each once. An extra one is refused, so a caller who sends a recipient,
 * a `to` or a `receiver` is told there is no such field instead of having it silently ignored.
 */
function strictQuery(c: Context, allowed: string[]): { ok: true; q: Record<string, string> } | { ok: false; res: Response } {
  const all = c.req.queries();
  const q: Record<string, string> = {};
  for (const [name, values] of Object.entries(all)) {
    if (!allowed.includes(name)) {
      const recipient = /recip|receiv|^to$|dest|payee|beneficiar/i.test(name);
      return { ok: false, res: bad(c, recipient ? "There is no recipient field. Every exit pays the position owner." : `Unknown parameter: ${name.slice(0, 40)}.`, recipient ? "no_recipient" : "unknown_parameter") };
    }
    if (values.length !== 1) return { ok: false, res: bad(c, `Send ${name} once.`) };
    q[name] = values[0]!;
  }
  for (const name of allowed) if (q[name] === undefined || q[name] === "") return { ok: false, res: bad(c, `Missing ${name}.`, "missing_parameter") };
  return { ok: true, q };
}

const addr = (s: string): Address | null => (isAddress(s, { strict: false }) ? getAddress(s.toLowerCase()) : null);

export function agentPlugin(): Plugin {
  return {
    name: "agent",
    api: (app: Hono, d: ApiDeps) => {
      const noContracts = (c: Context) => c.json({ error: "This deployment has no Canopy contracts.", code: "no_contracts" }, 503);

      app.get("/openapi.json", (c) => {
        c.header("Cache-Control", SHORT_CACHE);
        return c.json(buildOpenApi({ baseUrl: d.publicUrl ?? new URL(c.req.url).origin, perMin: d.rateLimit?.perMin ?? DEFAULT_RATE_LIMIT.perMin }));
      });

      app.get("/llms.txt", (c) => {
        const k = d.calldata;
        c.header("Cache-Control", SHORT_CACHE);
        return c.text(
          buildLlmsTxt({
            apiUrl: d.publicUrl ?? new URL(c.req.url).origin,
            siteUrl: d.appUrl,
            chain: k ? { chainId: k.chainId, router: k.router, adapter: k.adapter, alarmBook: k.alarmBook } : undefined,
          }),
          200,
          { "Content-Type": "text/plain; charset=utf-8" },
        );
      });

      app.get("/calldata/arm", async (c) => {
        const p = strictQuery(c, ["vault", "keys"]);
        if (!p.ok) return p.res;
        const vault = addr(p.q.vault!);
        if (!vault) return bad(c, "vault is not an address.", "bad_vault");
        const keys = [...new Set(p.q.keys!.split(",").map((k) => k.trim().toLowerCase()))];
        if (keys.length > MAX_KEYS) return bad(c, `A position arms at most ${MAX_KEYS} keys.`, "too_many_keys");
        if (keys.some((k) => !KEY.test(k))) return bad(c, "Every key is 0x followed by 64 hex digits, separated by commas.", "bad_key");
        const k = d.calldata;
        if (!k) return noContracts(c);

        const refused = await refusedKeys(k.reads, keys as Hex[]);
        const definite = refused.filter((r) => r.reason !== "unreadable");
        if (definite.length > 0) {
          return c.json({ error: "Some keys cannot be armed now. Nothing was built.", code: "keys_refused", keys: refused }, 422);
        }
        if (refused.length > 0) return c.json({ error: "The chain could not be read. Try again in a moment.", code: "chain_unavailable" }, 502);
        return c.json({ chainId: k.chainId, vault, keys, calls: [approveCall(vault, k.router), armCall(k.router, k.adapter, vault, keys as Hex[])] });
      });

      app.get("/calldata/exit", async (c) => {
        const p = strictQuery(c, ["vault", "owner"]);
        if (!p.ok) return p.res;
        const vault = addr(p.q.vault!);
        if (!vault) return bad(c, "vault is not an address.", "bad_vault");
        const owner = addr(p.q.owner!);
        if (!owner) return bad(c, "owner is not an address.", "bad_owner");
        const k = d.calldata;
        if (!k) return noContracts(c);

        let posId: Hex;
        let armed: boolean;
        try {
          posId = await k.reads.positionId(owner, vault);
          armed = await k.reads.isArmed(posId);
        } catch {
          return c.json({ error: "The chain could not be read. Try again in a moment.", code: "chain_unavailable" }, 502);
        }
        if (!armed) return c.json({ error: "That owner has no armed position in this vault. Withdraw from the vault as usual.", code: "not_armed" }, 404);
        return c.json({ chainId: k.chainId, vault, owner, positionId: posId, calls: [exitCall(k.router, posId)] });
      });

      app.get("/calldata/disarm-all", (c) => {
        const p = strictQuery(c, []);
        if (!p.ok) return p.res;
        const k = d.calldata;
        if (!k) return noContracts(c);
        return c.json({ chainId: k.chainId, calls: [disarmAllCall(k.router)] });
      });
    },
  };
}

export default agentPlugin();
