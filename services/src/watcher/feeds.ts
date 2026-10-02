const MAX_BYTES = 2_000_000;
const MAX_ITEMS = 10;
const MAX_AGE_SEC = 86_400;
const MAX_TEXT = 8_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? all;
    const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });

const clean = (s: string) => decode(s).replace(/<[^>]*>/g, " ").replace(/\0/g, "").replace(/\s+/g, " ").trim();

/** CDATA is text. Escaping it first means a tag inside a post can't open or close an item. */
const uncdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? "";

/** Splits RSS or Atom into recent items, so one new post is labelled alone and old posts cost nothing. Any other text counts as one item. */
export function feedItems(raw: string, now: number): string[] {
  const body = uncdata(raw);
  const blocks = body.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi);
  if (!blocks) {
    if (/<(rss|feed)[\s>]/i.test(body)) return []; // A valid feed with no posts.
    const text = clean(body);
    return text ? [text.slice(0, MAX_TEXT)] : [];
  }
  const items: string[] = [];
  for (const b of blocks) {
    const stamp = Date.parse(clean(tag(b, "pubDate") || tag(b, "updated") || tag(b, "published")));
    if (Number.isFinite(stamp) && stamp / 1000 < now - MAX_AGE_SEC) continue;
    const text = [tag(b, "title"), tag(b, "description") || tag(b, "content:encoded") || tag(b, "summary") || tag(b, "content")].map(clean).filter(Boolean).join(". ");
    if (text) items.push(text.slice(0, MAX_TEXT));
    if (items.length === MAX_ITEMS) break;
  }
  return items;
}

/** Local addresses are allowed for test stand-ins. Every other source must be HTTPS. */
export const allowedFeed = (url: string) => /^https:\/\//.test(url) || /^http:\/\/127\.0\.0\.1[:/]/.test(url);

/** Reads one allowlisted source. Redirects are refused, so a source can't lead off the list. A failing source returns nothing and never stops the others. */
export async function fetchFeed(url: string, now: number, get: typeof fetch = fetch): Promise<string[]> {
  if (!allowedFeed(url)) {
    console.error("feed refused", url);
    return [];
  }
  try {
    const res = await get(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/rss+xml, application/atom+xml, text/xml, text/plain" } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.text();
    if (body.length > MAX_BYTES) throw new Error("too large");
    return feedItems(body, now);
  } catch (e) {
    console.warn("feed", url, (e as Error).message);
    return [];
  }
}
