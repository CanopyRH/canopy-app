import { isAddress, type Address } from "viem";
import type { Plugin } from "../plugins";
import type { ApiDeps } from "../api/server";
import type { CardNumbers } from "../risk/card";
import { pageTitle, summary, XRAY, type XrayFacts } from "../copy/xray";
import { armedOn, CARD_H, CARD_W, factsFrom, renderPng, renderSvg } from "../xray/xray";

/** How long a vault's card is reused, in seconds. A card is the chain's numbers as of the last risk-card refresh, so five minutes is fine. */
export const XRAY_TTL = 300;
/** Cards kept at once. Only vaults with a saved risk card can be drawn, so this is a ceiling, not a working size. */
const MAX_CACHED = 500;

interface Entry {
  at: number;
  facts: XrayFacts;
  svg: string;
  png?: Promise<Uint8Array>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page a link to a vault's X-ray opens. Link previews read its meta tags, and people go on to the website. */
export function sharePage(f: XrayFacts, o: { pageUrl: string; imageUrl: string; siteUrl: string }): string {
  const to = `${o.siteUrl}/xray.html?vault=${f.vault}`;
  const title = esc(pageTitle(f));
  const desc = esc(`${summary(f)} ${XRAY.pitch}`);
  const alt = esc(`X-ray card for ${f.name}: ${summary(f)}`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${desc}">
<link rel="canonical" href="${esc(to)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Canopy">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${esc(o.pageUrl)}">
<meta property="og:image" content="${esc(o.imageUrl)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${CARD_W}">
<meta property="og:image:height" content="${CARD_H}">
<meta property="og:image:alt" content="${alt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${esc(o.imageUrl)}">
<meta name="twitter:image:alt" content="${alt}">
<meta http-equiv="refresh" content="0;url=${esc(to)}">
</head><body><p><a href="${esc(to)}">See the X-ray of ${esc(f.name)} on ${XRAY.site}</a></p></body></html>
`;
}

export function xrayRoutes(d: ApiDeps, cache = new Map<string, Promise<Entry | null>>()) {
  const build = async (vault: Address): Promise<Entry | null> => {
    const row = await d.repo.card(vault.toLowerCase());
    if (!row) return null;
    const facts = factsFrom({ ...(row.numbers as CardNumbers), vault }, await armedOn(d.db, vault));
    return { at: d.now(), facts, svg: renderSvg(facts) };
  };
  const get = async (vault: Address): Promise<Entry | null> => {
    const key = vault.toLowerCase();
    const hit = cache.get(key);
    if (hit) {
      const e = await hit.catch(() => null);
      if (e && d.now() - e.at < XRAY_TTL) return e;
      if (cache.get(key) === hit) cache.delete(key);
    }
    const p = build(vault);
    cache.set(key, p);
    p.then((e) => e ?? cache.delete(key), () => cache.delete(key));
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
    return p;
  };
  return { get };
}

const plugin: Plugin = {
  name: "xray",
  api: (app, d) => {
    const { get } = xrayRoutes(d);
    app.get("/xray/:file", async (c) => {
      const m = /^(0x[0-9a-fA-F]{40})(?:\.(png|svg|json))?$/.exec(c.req.param("file"));
      if (!m || !isAddress(m[1]!)) return c.json({ error: "bad address" }, 400);
      const vault = m[1]!.toLowerCase() as Address;
      const e = await get(vault);
      if (!e) return c.json({ error: "unknown vault" }, 404);
      c.header("Cache-Control", `public, max-age=${XRAY_TTL}`);
      const kind = m[2];
      if (kind === "svg") return c.body(e.svg, 200, { "Content-Type": "image/svg+xml; charset=utf-8" });
      if (kind === "png") {
        e.png ??= renderPng(e.svg);
        let png: Uint8Array;
        try {
          png = await e.png;
        } catch {
          e.png = undefined;
          c.header("Cache-Control", "no-store");
          return c.json({ error: "could not draw the card" }, 503);
        }
        return c.body(png as unknown as ArrayBuffer, 200, { "Content-Type": "image/png" });
      }
      const origin = d.publicUrl?.replace(/\/+$/, "") ?? new URL(c.req.url).origin;
      const siteUrl = (d.siteUrl ?? XRAY.siteUrl).replace(/\/+$/, "");
      if (kind === "json") return c.json({ ...e.facts, summary: summary(e.facts), image: `${origin}/xray/${vault}.png`, share: `${origin}/xray/${vault}` });
      c.header("Content-Security-Policy", "default-src 'none'");
      return c.html(sharePage(e.facts, { pageUrl: `${origin}/xray/${vault}`, imageUrl: `${origin}/xray/${vault}.png`, siteUrl }));
    });
  },
};

export default plugin;
