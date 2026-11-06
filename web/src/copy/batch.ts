/** Wording for one-step arming. Lives in copy/ so the banned-words gate checks it. */

export const BATCH_COPY = {
  oneConfirm: "One confirmation in your wallet",
  threeSteps: "3 steps",
  batchFailed: "Your wallet reported that the batch failed. Nothing is armed.",
  batchPartial: "Some steps went through and some didn't. Check your position, then try again. Only the missing steps will be asked for.",
  batchUnknown: "Your wallet hasn't said how the batch went. Check your position before you try again.",
} as const;
