/** CI gate: user-facing copy may not use return, rate, cover or guarantee language. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const BANNED = [
  /\bapy\b/i,
  /\bapr\b/i,
  /\byields?\b/i,
  /\breturns?\s+(of|up to)\b/i,
  /\bguarantee[ds]?\b/i,
  /\bprofits?\b/i,
  /\bmoney[- ]back\b/i,
  /\binsured\b/i,
  /\binsurance\b/i,
  /\breimburse(d|ment|s)?\b/i,
  /\brisk[- ]free\b/i,
  /\bcan'?t lose\b/i,
  /\balways gets? out\b/i,
  /\bendorsed\b/i,
];

export function findBanned(text: string): string[] {
  return BANNED.filter((r) => r.test(text)).map((r) => r.source);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const dirs = [join(root, "services/src/copy"), join(root, "web/src/copy")].filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
  const bad = dirs.flatMap(walk).flatMap((f) => findBanned(readFileSync(f, "utf8")).map((w) => `${f}: ${w}`));
  for (const b of bad) console.error(b);
  console.log(bad.length ? `${bad.length} banned-word hits` : `banned words: clean (${dirs.length} folders)`);
  process.exit(bad.length ? 1 : 0);
}
