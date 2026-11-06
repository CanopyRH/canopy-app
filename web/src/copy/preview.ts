/** Wording for the exit preview. It lives here so the banned-words gate checks it. */

export const PREVIEW = {
  title: "What you'd get back right now",
  help: "If an alarm fired this second, this is what an exit would pay your wallet. Your browser reads it from the chain, and nothing is sent.",
  refresh: "Read again",
  reading: "Reading the vault…",
  empty: "Check a wallet to see what an exit would pay.",
  none: "No positions to preview.",
  armedTag: "Armed",
  idleTag: "Not armed",
  youGet: "An exit now pays",
  worth: "Full position",
  alarmsTitleArmed: "Your alarms",
  alarmsTitleIdle: "Alarms you could choose",
  noAlarms: "Alarms are read once auto-exit is live.",
  alarmsUnread: "Canopy can't read the alarms just now.",
  clear: "Clear",
  goingOff: "Going off",
  unreadable: "Can't be read",
  customAlarm: "Custom alarm",
  liquidityFull: "The vault can pay all of it now.",
  liquidityPartial: "The vault can pay only part of it now.",
  liquidityNone: "The vault can't pay anything now.",
} as const;

/** The one-line verdicts. Each takes amounts already formatted with the asset name. */
export const VERDICT = {
  unreadable: "Canopy can't read this vault just now, so it can't say what an exit would pay.",
  blocked: "This vault's gates would block an exit. To leave, withdraw from the vault itself.",
  noApproval: "The router has no approval to take your shares, so an exit would pay nothing. Arm again to fix that.",
  none: "The vault can't pay anything right now. Your shares would stay in your wallet.",
  full: (pay: string) => `An exit now would pay you ${pay}.`,
  fullIdle: (pay: string) => `Not armed. If it were, an exit now would pay you ${pay}.`,
  partial: (pay: string, all: string) => `The vault can pay only ${pay} of ${all} now. The rest stays as shares in your wallet.`,
  partialApproval: (percent: number) => `The router may take only ${percent}% of your shares.`,
  alarmsClear: "All alarms are clear.",
  alarmsGoingOff: "An alarm is going off now.",
  alarmsUnreadable: "Some alarms can't be read.",
} as const;
