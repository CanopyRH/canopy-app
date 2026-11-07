import { z } from "zod";
const seconds = z.number().int().nonnegative().safe();
export const Calendar = z
  .strictObject({
    source: z.url().refine((s) => s.startsWith("https://")),
    reviewedAt: seconds,
    validFrom: seconds,
    validUntil: seconds,
    windows: z
      .array(z.strictObject({ open: seconds, close: seconds }))
      .min(1)
      .max(128),
  })
  .superRefine((c, ctx) => {
    let end = c.validFrom;
    if (c.validUntil <= c.validFrom || c.reviewedAt > c.validFrom)
      ctx.addIssue({ code: "custom", message: "Invalid calendar validity" });
    for (const w of c.windows) {
      if (w.open < end || w.close <= w.open || w.close > c.validUntil)
        ctx.addIssue({
          code: "custom",
          message: "Overlapping or invalid UTC intervals",
        });
      end = w.close;
    }
  });
export type Calendar = z.infer<typeof Calendar>;
/** No assumed CET offset or holiday rules: the reviewed calendar specifies absolute UTC instants. */
export function sessionState(
  calendar: Calendar,
  now: number,
  preCloseSeconds: number,
  feed: {
    updatedAt: number;
    heartbeat: number;
    positive: boolean;
    paused: boolean | null;
  },
  multiplierChanged = false,
) {
  Calendar.parse(calendar);
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(preCloseSeconds) ||
    preCloseSeconds < 0 ||
    !Number.isSafeInteger(feed.heartbeat) ||
    feed.heartbeat <= 0
  )
    throw new Error("Invalid session observation");
  const covered = now >= calendar.validFrom && now < calendar.validUntil;
  const window = covered
    ? calendar.windows.find((w) => w.open <= now && now < w.close)
    : undefined;
  const age =
    Number.isSafeInteger(feed.updatedAt) &&
    feed.updatedAt > 0 &&
    feed.updatedAt <= now
      ? now - feed.updatedAt
      : null;
  const feedFresh =
    age !== null &&
    age <= feed.heartbeat &&
    feed.positive &&
    feed.paused === false;
  const reasons = [
    ...(!covered ? ["calendar-unknown"] : !window ? ["session-closed"] : []),
    ...(!feedFresh ? ["feed-stale-paused-or-unknown"] : []),
    ...(multiplierChanged ? ["multiplier-changed"] : []),
  ];
  return {
    state: !covered ? "unknown" : window ? "open" : "closed",
    secondsToClose: window ? window.close - now : null,
    preClose: !!window && window.close - now <= preCloseSeconds,
    feedAge: age,
    allowSwap: !!window && feedFresh && !multiplierChanged,
    reasons,
    source: calendar.source,
  };
}
