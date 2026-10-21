/** All app wording lives here so the banned-words gate can check it. */

export const TERMS_VERSION = "draft-1";

/** Draft wording for counsel to replace before launch. Its hash is recorded on-chain when a position is armed. */
export const TERMS = `Canopy is software. It tries to exit your position when an alarm you chose fires.
It can fail. A vault may have no withdrawable funds, an alarm may fire late or wrongly, and a contract may have a bug.
Canopy does not hold your funds, does not promise any outcome and does not cover losses.
An exit gives up your position. Getting back in is up to you.
You choose your alarms. You can disarm at any time.`;
