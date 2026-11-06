import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findBanned } from "../../tools/banned-words";
import { imageUrl, intentUrl, PITCH, shareText, shareUrl, SITE, VAULT_PARAM, XRAY_COPY } from "../src/copy/xray";
import { COPY } from "../src/copy/text";
import mainnet from "../src/mainnet.json";

const V = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
const SUMMARY = "Steakhouse USDG: 24.9% liquid now (1,052,594 USDG), 3 of 3 gates given up, 3 armed with Canopy.";
const html = readFileSync(join(import.meta.dir, "../public/xray.html"), "utf8");
const meta = (k: string) => new RegExp(`<meta (?:property|name)="${k}" content="([^"]*)">`).exec(html)?.[1];

describe("share link", () => {
  test("the text carries the facts, the pitch and the site, and fits in a post", () => {
    const t = shareText({ summary: SUMMARY });
    expect(t).toBe(`${SUMMARY}\n\n${PITCH} ${SITE}`);
    expect(t).toContain("canopyrh.com");
    expect(shareText({ summary: "x".repeat(400) }).length).toBeLessThanOrEqual(230);
    expect(shareText({ summary: "x".repeat(400) })).toEndWith(`${PITCH} ${SITE}`);
  });

  test("the X intent link prefills the text and the share page URL", () => {
    const url = shareUrl("https://api.canopyrh.com/", V);
    expect(url).toBe(`https://api.canopyrh.com/xray/${V.toLowerCase()}`);
    const u = new URL(intentUrl(shareText({ summary: SUMMARY }), url));
    expect(u.origin + u.pathname).toBe("https://x.com/intent/post");
    expect(u.searchParams.get("text")).toBe(shareText({ summary: SUMMARY }));
    expect(u.searchParams.get("url")).toBe(url);
    expect(imageUrl("https://api.canopyrh.com", V)).toBe(`${url}.png`);
  });

  test("only a full vault address is accepted from the page address", () => {
    expect(VAULT_PARAM.test(V)).toBe(true);
    for (const bad of ["", "0x123", `${V}0`, "0xZeEff033F34C046626B8D0A041844C5d1A5409dd", "<script>"]) expect(VAULT_PARAM.test(bad)).toBe(false);
  });

  test("the wording passes the banned-words gate", () => {
    expect(findBanned(Object.values(XRAY_COPY).join("\n") + PITCH + COPY.shareXray)).toEqual([]);
  });
});

describe("xray.html", () => {
  test("link previews point at the API image and the page asks for a large card", () => {
    expect(meta("og:image")).toMatch(new RegExp(`^${mainnet.apiUrl}/xray/0x[0-9a-f]{40}\\.png$`));
    expect(meta("twitter:image")).toBe(meta("og:image"));
    expect(meta("twitter:card")).toBe("summary_large_image");
    expect(meta("og:title")).toBeTruthy();
    expect(meta("og:description")).toContain(PITCH);
    expect(meta("og:url")).toBe(`https://${SITE}/xray.html`);
  });

  test("the CSP lets the page load images from the API origin and nowhere new", () => {
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)![1]!;
    const img = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"))!;
    expect(img).toBe(`img-src 'self' data: ${mainnet.apiUrl}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  test("it is the page the build wires to src/site/pages/xray.jsx", () => {
    expect(html).toContain('data-page="xray"');
    expect(readFileSync(join(import.meta.dir, "../src/site/pages/xray.jsx"), "utf8")).toContain("export default function Xray");
  });

  test("the app's risk card has a Share X-ray link to the page", () => {
    const app = readFileSync(join(import.meta.dir, "../src/app/App.tsx"), "utf8");
    expect(app).toContain("xray.html?vault=");
    expect(COPY.shareXray).toBe("Share X-ray");
  });
});
