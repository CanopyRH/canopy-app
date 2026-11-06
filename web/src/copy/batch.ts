/** Wording for one-step arming. Lives in copy/ so the banned-words gate checks it. */

export const BATCH_COPY = {
  /** How many times the wallet will ask, counted from the chain for the alarms picked. */
  confirms: (n: number) => (n === 1 ? "One confirmation in your wallet" : `${n} confirmations in your wallet`),
  batchFailed: "Your wallet reported that the batch failed. Nothing is armed.",
  batchPartial: "Some steps went through and some didn't. Check your position, then try again. Only the missing steps will be asked for.",
  batchUnknown: "Your wallet hasn't said how the batch went. Check your position before you try again.",
} as const;
