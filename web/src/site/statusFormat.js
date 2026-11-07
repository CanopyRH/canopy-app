// Wording and judgement for the status page. Plain functions, so they are easy to test.
import copy from '../copy/status.json';

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

/** "45 s", "4 min 10 s", "1 h 5 min". */
export function duration(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
  const m = Math.floor((s % 3600) / 60);
  return m ? `${Math.floor(s / 3600)} h ${m} min` : `${s / 3600} h`;
}

export const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** "12 blocks", "1 block", or null when unknown. */
export const blocks = (n) => (n === null || n === undefined ? null : `${n.toLocaleString('en-US')} block${n === 1 ? '' : 's'}`);

/** Name for an admin event, falling back to the raw event name. */
export const eventTitle = (e) => copy.events[e] || e;

// Alarm checks run every minute. A few minutes of silence is a delay; ten is a stall.
export const CHECKS_WARN_SEC = 180;
export const CHECKS_BAD_SEC = 600;
// An exit that has waited this long in the queue is worth a look.
export const QUEUE_WARN_SEC = 300;

/** Judges each part of the answer: 'ok', 'warn', 'bad' or 'unknown'. */
export function levels(s, nowSec) {
  const gas = { healthy: 'ok', low: 'warn', empty: 'bad' }[s.keeper.gas] || 'unknown';
  const queue = s.keeper.queueDepth > 0 && s.keeper.oldestQueuedSec >= QUEUE_WARN_SEC ? 'warn' : 'ok';
  const indexer = { ok: 'ok', behind: 'bad' }[s.indexer.state] || 'unknown';
  const age = s.alarmChecks.lastCheckedAt === null ? null : Math.max(0, nowSec - s.alarmChecks.lastCheckedAt);
  const checks = age === null ? 'unknown' : age >= CHECKS_BAD_SEC ? 'bad' : age >= CHECKS_WARN_SEC ? 'warn' : 'ok';
  return { gas, queue, indexer, checks };
}

/** One verdict for the page: the worst part wins. Parts that cannot be read count as a warning, unless nothing can be read. */
export function verdict(s, nowSec) {
  const l = Object.values(levels(s, nowSec));
  if (l.includes('bad')) return 'bad';
  if (l.includes('warn')) return 'warn';
  const p=s.watchers?.policy;
  if(p && (!p.reportAttributionConfigured || !p.diversityRequired || !p.profilesConfigured))return 'warn';
  const unknown = l.filter((x) => x === 'unknown').length;
  if (unknown === 0) return 'ok';
  return unknown >= l.length - 1 ? 'unknown' : 'warn';
}

/** Checks the shape of the answer, so a wrong or old server shows the error state rather than a broken page. */
export function validStatus(b) {
  const arr = Array.isArray;
  return !!b && typeof b.generatedAt === 'number'
    && !!b.keeper && typeof b.keeper.queueDepth === 'number' && typeof b.keeper.gas === 'string'
    && !!b.indexer && typeof b.indexer.state === 'string'
    && !!b.watchers && arr(b.watchers.list)
    && !!b.alarmChecks
    && arr(b.history)
    && !!b.alarmFirings && typeof b.alarmFirings.total === 'number' && arr(b.alarmFirings.byDay) && arr(b.alarmFirings.recent);
}

/** "Today", "Yesterday" or "3 days ago", for the per-day firing counts. */
export const dayLabel = (n) => (n === 0 ? 'Today' : n === 1 ? 'Yesterday' : `${n} days ago`);
