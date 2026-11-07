/** All alert wording lives here so the banned-words gate can check it. */

export interface AlertInput {
  vaultName: string;
  alarm: string;
  evidenceUrl?: string;
  withdrawInRobinhoodApp?: boolean;
}

/** Names by AlarmBook.Kind. */
export const ALARM_NAMES = ["a price alarm", "a vault loss alarm", "a pause alarm", "an address change alarm", "a drain alarm", "an exploit alarm confirmed by watchers", "a confirmed alarm"];

export function alarmAlert(a: AlertInput): string {
  const lines = [`Alarm on ${a.vaultName}: ${a.alarm}.`];
  lines.push(
    a.withdrawInRobinhoodApp
      ? "If you hold this vault in Robinhood Earn, you can withdraw in the Robinhood app."
      : "Armed positions with a paid plan are exiting now. Funds go only to each owner's wallet.",
  );
  lines.push("You can also withdraw yourself at any time.");
  if (!a.withdrawInRobinhoodApp) lines.push(EXIT_HINT);
  if (a.evidenceUrl) lines.push(`Evidence: ${a.evidenceUrl}`);
  return lines.join("\n");
}

export const EXIT_HINT = "To leave this vault yourself, tap Exit now below and sign in your own wallet. Canopy never signs for you.";
export const EXIT_BUTTON = "Exit now";
export const RISK_BUTTON = "Open risk card";
export const DISARM_BUTTON = "Disarm all";
export const exitButtonFor = (name: string) => `Exit ${name}`.slice(0, 60);

export const PANIC_TEXT = [
  "Panic button. Nothing happens until you tap a button below and confirm in your own wallet.",
  "Disarm all stops every armed exit for your wallet. Exit moves one vault's position back to your wallet.",
  "Canopy never signs for you and never holds your keys. The Canopy app opens, you connect your wallet, and you sign there.",
].join("\n");
export const PANIC_NO_VAULTS = "You aren't following any vaults yet, so there are no Exit buttons. Follow one with /watch <vault address>. Disarm all still works for any wallet.";
export const exitReply = (name: string) =>
  `Exit ${name}: tap the button, connect your wallet in the Canopy app, check the details and sign. Canopy never signs for you and never holds your keys. Funds go only to your wallet.`;
export const EXIT_USAGE = "Send a vault address or name: /exit 0x... or /exit <vault name>. /panic shows buttons for every vault you follow.";
export const exitNotFound = (q: string) => `No vault found for "${q.slice(0, 60)}". Send its address, or see the vaults Canopy lists with /vaults.`;
export const exitMany = "More than one vault matches. Pick the one you mean. Each button opens the Canopy app, where you sign in your own wallet.";

/** Plain wording for a signal read from the chain. */
export function signalLine(kind: string, value: number): string {
  switch (kind) {
    case "PAUSED": return "the vault reports that it is paused";
    case "SHARE_DROP": return `the share price fell ${(value / 100).toFixed(2)}% below its high`;
    case "DRAIN": return `about ${Math.round(value / 100)}% of its assets left within an hour. Big honest withdrawals look the same`;
    case "GOVERNANCE": return "its owner or curator changed";
    default: return "something changed on-chain";
  }
}

/** A free follower alert. It reports what the chain shows, and no exit follows from it alone. */
export function watchAlert(a: { vaultName: string; what: string; withdrawInRobinhoodApp?: boolean }): string {
  return [
    `Heads up on ${a.vaultName}: ${a.what}.`,
    a.withdrawInRobinhoodApp
      ? "If you hold this vault in Robinhood Earn, you can withdraw in the Robinhood app."
      : "This alert moves nothing. You can withdraw yourself at any time.",
  ].join("\n");
}

export const WELCOME = [
  "Canopy watches DeFi vaults and tells you when an alarm fires.",
  "See the vaults we watch with /vaults, and follow one with /watch <vault address>. This needs no wallet connection.",
  "Canopy does not promise any outcome and does not pay for losses.",
].join("\n");
