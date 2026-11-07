import { isAddress } from "viem";
import { allowedFeed } from "./feeds";

/**
 * Settings a watcher never reads. It signs with its key, reads feeds, and posts to its peers: it sends no Telegram message
 * and serves no webhook. The shared env check still wants a value for each, so ROLE=watcher gets a placeholder for any of
 * these left blank. They point nowhere, so a future change that starts using one fails loudly.
 *
 * RPC_URL is not here: every service checks at start that its AlarmBook is the v2 contract (a v1 address would make the
 * watcher sign under the wrong EIP-712 domain, and nothing would accept its signatures), so a watcher needs one real
 * endpoint. RPC_URL_BACKUP follows RPC_URL when left blank.
 */
export const WATCHER_UNUSED: Record<string, string> = {
  PUBLIC_URL: "http://127.0.0.1",
  RPC_URL_BACKUP: "http://127.0.0.1:1",
  TELEGRAM_BOT_TOKEN: "0:watcher-role-unused",
  TELEGRAM_WEBHOOK_SECRET: "watcher-role-unused-secret",
};

/** Fills the unused settings for ROLE=watcher only. Every other role gets its settings back untouched. */
export function withWatcherDefaults<T extends Record<string, string | undefined>>(raw: T): T {
  return raw.ROLE === "watcher" ? { ...WATCHER_UNUSED, ...(raw.RPC_URL ? { RPC_URL_BACKUP: raw.RPC_URL } : {}), ...raw } : raw;
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export interface WatcherSettings {
  ALERTS_ONLY: boolean;
  ALARM_BOOK?: string;
  WATCHER_PRIVATE_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  WATCHERS: string;
  WATCHER_PEERS: string;
  FEED_URLS: string;
}

/**
 * What a watcher needs, and nothing else. A watcher missing its key used to start and do nothing, with no message, so each
 * is checked here and named. Contract settings other than the AlarmBook (router, adapter, plan payment) are not needed.
 */
export function watcherProblems(e: WatcherSettings): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const bad = (path: string, message: string) => out.push({ path, message });
  if (e.ALERTS_ONLY) bad("ALERTS_ONLY", "a watcher signs for the AlarmBook, so ALERTS_ONLY must be off");
  if (!e.ALARM_BOOK) bad("ALARM_BOOK", "required for a watcher");
  if (!e.WATCHER_PRIVATE_KEY) bad("WATCHER_PRIVATE_KEY", "required for a watcher");
  else if (!/^0x[0-9a-fA-F]{64}$/.test(e.WATCHER_PRIVATE_KEY)) bad("WATCHER_PRIVATE_KEY", "must be 0x followed by 64 hex characters");
  if (!e.ANTHROPIC_API_KEY) bad("ANTHROPIC_API_KEY", "required for a watcher, which labels reports with it");
  // Empty lists are allowed, as in a rehearsal that only reads feeds. A list that is set has to be well formed.
  if (list(e.WATCHERS).some((w) => !isAddress(w, { strict: false }))) bad("WATCHERS", "every entry must be an address");
  if (list(e.WATCHER_PEERS).some((p) => !/^https?:\/\/[^\s/]+(\/[^\s]*[^\s/])?$/.test(p))) bad("WATCHER_PEERS", "every entry must be a URL with no trailing slash");
  if (list(e.FEED_URLS).some((f) => !allowedFeed(f))) bad("FEED_URLS", "every source must be an https URL");
  return out;
}
