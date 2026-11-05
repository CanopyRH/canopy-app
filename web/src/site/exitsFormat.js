// Wording and number formats for the exit log. Plain functions, so they are easy to test.

/** "5 min ago". Returns null when the time is unknown. */
export function ago(nowSec, at) {
  if (at === null || at === undefined) return null;
  const s = Math.max(0, nowSec - at);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

/** "45 s", "4 min 10 s", "1 h 5 min". Returns null when unknown. */
export function duration(sec) {
  if (sec === null || sec === undefined) return null;
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
  const m = Math.floor((s % 3600) / 60);
  return m ? `${Math.floor(s / 3600)} h ${m} min` : `${s / 3600} h`;
}

/** Whole-token text from a raw amount, with up to 4 decimals and no trailing zeros. */
export function tokenAmount(raw, decimals) {
  let n;
  try { n = BigInt(raw); } catch { return null; }
  const unit = 10n ** BigInt(decimals);
  const whole = (n / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (n % unit).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
  if (n > 0n && whole === '0' && !frac) return 'under 0.0001';
  return frac ? `${whole}.${frac}` : whole;
}

export const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** What came back for one payout. Falls back to the token address when its symbol is not known. */
export function paidText(p, known) {
  const symbol = p.symbol || known?.symbol || null;
  const decimals = p.decimals ?? known?.decimals ?? null;
  const amount = decimals === null ? null : tokenAmount(p.amount, decimals);
  if (amount === null || !symbol) return { amount: p.amount, unit: `units of ${shortAddress(p.token)}` };
  return { amount, unit: symbol };
}

/** "a price alarm" becomes "Price alarm"; the leading article is dropped. */
export function alarmTitle(name) {
  const t = name.replace(/^(an?|the)\s+/i, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
