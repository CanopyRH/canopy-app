/** Wording for the alarm level picker. It lives here so the banned-words gate checks it. */

export const LEVEL_COPY = {
  title: "How big a dip should exit you?",
  /** The trade-off, in one line. */
  tradeoff: "A smaller level exits you sooner, on smaller dips; a bigger level waits for a bigger loss.",
  off: "No vault loss alarm",
  offNote: "Leave this one out.",
  /** Shown under each level. `label` is like "2%". */
  note: (label: string) => `Goes off when the share price is ${label} below its high.`,
  tripped: "Already going off, so Canopy won't arm it.",
  unreadable: "Canopy can't read this level just now. Try again in a moment.",
  reading: "Reading the chain…",
} as const;
