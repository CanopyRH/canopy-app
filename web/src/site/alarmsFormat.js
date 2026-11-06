// Wording and number formats for the alarm record. Plain functions, so they are easy to test.
import { duration } from './exitsFormat.js';

export const OUTCOMES = [
  { id: '', label: 'All outcomes' },
  { id: 'exited', label: 'Exit followed' },
  { id: 'no_exit', label: 'No exit' },
  { id: 'no_armed_positions', label: 'No armed positions' },
];

/** The outcome as a short label, and how it should be styled: good, bad or plain. */
export function outcomeLabel(row) {
  if (row.outcome === 'exited') return { text: row.exits.count === 1 ? '1 exit followed' : `${row.exits.count} exits followed`, tone: 'exit' };
  if (row.outcome === 'no_exit') return row.open ? { text: 'No exit yet', tone: 'open' } : { text: 'No exit', tone: 'miss' };
  return { text: 'No armed positions', tone: 'none' };
}

/** One line of detail under the outcome, such as "First exit after 40 s". */
export function outcomeDetail(row, paid) {
  if (row.outcome === 'exited') {
    const first = duration(row.exits.firstAfterSeconds);
    return [first ? `First exit after ${first}` : 'Exit time not read yet', ...(paid ? [paid] : [])].join(' · ');
  }
  if (row.outcome === 'no_exit') return row.open ? 'Armed positions are still inside the 24 hours' : 'Armed positions, but no exit within 24 hours';
  return 'Nobody had this alarm armed, so no exit was due';
}

export const ruleLabel = (rule) => (rule === 'quorum' ? 'Watcher quorum' : 'Hard rule');

export function verdictLabel(verdict) {
  if (verdict === 'false_alarm') return { text: 'False alarm', tone: 'false' };
  if (verdict === 'confirmed') return { text: 'Confirmed', tone: 'confirmed' };
  return { text: 'Not yet reviewed', tone: 'unreviewed' };
}

/** "2 marked false alarm, 1 confirmed, 4 not yet reviewed". Unreviewed alarms are never counted as correct. */
export function reviewLine(f) {
  return `${f.falseAlarm} marked false alarm · ${f.confirmed} confirmed · ${f.unreviewed} not yet reviewed`;
}

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The text of the "Post on X" button, from the live numbers. */
export function tweetText(s) {
  if (!s || s.fired.all === 0) {
    return "Canopy's public alarm record is live. No alarms have fired yet. Each one that does will be listed with what happened next, and so will every miss and false alarm.";
  }
  const parts = [`${plural(s.fired.all, 'alarm', 'alarms')} fired`, `${plural(s.alarmsWithExit, 'alarm', 'alarms')} followed by an exit`];
  const typical = duration(s.medianSecondsToExit);
  if (typical) parts.push(`typical time to exit ${typical}`);
  if (s.noExit) parts.push(`${plural(s.noExit, 'miss', 'misses')}`);
  const f = s.falseAlarms;
  return `Canopy's public alarm record: ${parts.join(', ')}. ${f.falseAlarm} marked false alarm, ${f.unreviewed} not yet reviewed. Hits, misses and false alarms all stay on the list.`;
}

export function postOnXUrl(text, pageUrl) {
  const q = new URLSearchParams({ text, ...(pageUrl ? { url: pageUrl } : {}) });
  return `https://x.com/intent/tweet?${q}`;
}

/** The API query for the current filters. */
export function recordQuery({ vault = '', outcome = '', before = '', limit = 20 } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (vault) q.set('vault', vault);
  if (outcome) q.set('outcome', outcome);
  if (before) q.set('before', before);
  return q.toString();
}
