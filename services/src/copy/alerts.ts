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
  if (a.evidenceUrl) lines.push(`Evidence: ${a.evidenceUrl}`);
  return lines.join("\n");
}

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
  "See the vaults we cover with /vaults, and follow one with /watch <vault address>. This needs no wallet connection.",
  "Canopy does not promise any outcome and does not cover losses.",
].join("\n");
