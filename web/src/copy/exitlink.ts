/** Wording for links that come from the Telegram bot. The banned-words gate checks this folder. */

export const LINK_COPY = {
  refused: "That link isn't one Canopy recognises, so it was ignored. Nothing was opened and nothing was sent.",
  disarmConnect: "Disarm all: connect your wallet to continue. You sign in your own wallet, and Canopy never signs for you.",
  exitConnect: (vault: string) => `Exit ${vault}: connect your wallet to continue. You sign in your own wallet, and Canopy never signs for you.`,
  unknownVault: "Canopy doesn't list that vault, so it can't open an exit for it. You can still withdraw from the vault yourself.",
  noPosition: (vault: string) => `The wallet you connected has no position in ${vault}. Check that you connected the wallet that holds it.`,
  notArmed: (vault: string) => `Your position in ${vault} isn't armed, so there is no Canopy exit to run. You can withdraw from the vault yourself.`,
  exitTitle: (vault: string) => `Exit ${vault}?`,
  exitBody: "This sends one transaction that moves your whole position in this vault back to your wallet. You sign it in your own wallet. Canopy never signs for you and never holds your keys, and funds go only to your wallet.",
  exitKeep: "Keep my position",
  disarmBody: "You sign this in your own wallet. Canopy never signs for you.",
  riskTitle: (vault: string) => `Risk card: ${vault}`,
  close: "Close",
} as const;
