import { z } from "zod";
import { Calendar, sessionState } from "../rwa/session";
export const SessionInput = z.strictObject({
  calendar: Calendar.refine(
    (c) => c.validUntil <= 253402300799,
    "Calendar exceeds supported dates",
  ),
  preCloseSeconds: z.number().int().min(0).max(86400),
  feed: z.strictObject({
    updatedAt: z.number().int().nonnegative().safe(),
    heartbeat: z.number().int().min(1).max(604800),
    positive: z.boolean(),
    paused: z.boolean().nullable(),
  }),
  multiplierChanged: z.boolean(),
});
export function sessionPlan(raw: unknown, now = Math.floor(Date.now() / 1000)) {
  const r = SessionInput.parse(raw),
    state = sessionState(
      r.calendar,
      now,
      r.preCloseSeconds,
      r.feed,
      r.multiplierChanged,
    );
  return {
    version: 1,
    feature: "sessions",
    observedAt: { evaluatedAt: now },
    data: {
      ...state,
      nextWindows: r.calendar.windows.filter((w) => w.close > now).slice(0, 16),
      expiresAt: r.calendar.validUntil,
      calendarReviewedAt: r.calendar.reviewedAt,
      preCloseSeconds: r.preCloseSeconds,
    },
    limitations: [
      "The calendar and feed observation are supplied by the user, not verified by Canopy. This is a planning calculation, not an execution permission.",
      "No holidays or daylight-saving offsets are inferred. Import a reviewed UTC calendar; expired coverage is unknown. Nothing is scheduled or traded.",
    ],
  };
}
export function sessionIcs(raw: unknown) {
  const { calendar, preCloseSeconds } = SessionInput.parse(raw);
  const stamp = (t: number) =>
    new Date(t * 1000)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Canopy//Session Planner//EN",
    ...calendar.windows.flatMap((w) => [
      "BEGIN:VEVENT",
      `UID:canopy-session-${w.open}-${w.close}@canopy.invalid`,
      `DTSTAMP:${stamp(calendar.reviewedAt)}`,
      `DTSTART:${stamp(Math.max(w.open, w.close - preCloseSeconds))}`,
      `DTEND:${stamp(w.close)}`,
      "SUMMARY:Review exposure before session close",
      "DESCRIPTION:User-imported UTC calendar. No automated transaction.",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
