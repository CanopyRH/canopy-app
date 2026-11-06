/**
 * RPC providers put the API key in the URL path, database URLs carry a password, and error messages quote both. Logs
 * only ever show a URL's scheme and host, whatever the scheme, so no key or password reaches them.
 */
export const scrubUrls = (s: string) =>
  s.replace(/\b([a-z][a-z0-9+.-]*):\/\/([^\s"'`<>]*)/gi, (_m, scheme: string, rest: string) => {
    // Drop everything up to the last @, so a user:password is gone even if it holds a / or #, then keep the host and port.
    const host = rest.slice(rest.lastIndexOf("@") + 1).split(/[/?#]/, 1)[0]!;
    return `${scheme}://${host}/…`;
  });

const scrub = (v: unknown): unknown => {
  if (typeof v === "string") return scrubUrls(v);
  if (v instanceof Error) return scrubUrls(`${v.name}: ${v.message}`);
  // An object logged as it is would be printed by the console after scrubbing, with any URL inside it intact.
  if (v !== null && (typeof v === "object" || typeof v === "function")) return scrubUrls(Bun.inspect(v));
  return v;
};

/** Scrubs every console line this process writes. Call once at startup. */
export function scrubConsole() {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const write = console[level].bind(console);
    console[level] = (...args: unknown[]) => write(...args.map(scrub));
  }
}
