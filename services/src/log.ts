/**
 * RPC providers put the API key in the URL path, and viem error messages quote the URL. Logs only ever show a URL's
 * host, so no key reaches them.
 */
export const scrubUrls = (s: string) => s.replace(/\b(https?|wss?):\/\/([^\s/"'`<>]+)[^\s"'`<>]*/g, (_m, scheme: string, host: string) => `${scheme}://${host.replace(/^[^@]*@/, "")}/…`);

const scrub = (v: unknown): unknown => {
  if (typeof v === "string") return scrubUrls(v);
  if (v instanceof Error) return scrubUrls(`${v.name}: ${v.message}`);
  return v;
};

/** Scrubs every console line this process writes. Call once at startup. */
export function scrubConsole() {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const write = console[level].bind(console);
    console[level] = (...args: unknown[]) => write(...args.map(scrub));
  }
}
