/**
 * The terms whose hash is recorded on-chain when a position is armed. This is a copy of TERMS in web/src/copy/text.ts: the
 * services image holds no web files. A web test fails if the two differ, so an arm built here always carries the hash the
 * app would record.
 */
export const TERMS = `Canopy is software. It tries to exit your position when an alarm you chose fires.
It can fail. A vault may have no withdrawable funds, an alarm may fire late or wrongly, and a contract may have a bug.
Canopy does not hold your funds, does not promise any outcome and does not cover losses.
An exit gives up your position. Getting back in is up to you.
You choose your alarms. You can disarm at any time.`;
