/** Words for the whale panel on a vault's risk card. Kept apart from text.ts so the shared copy file stays untouched; the banned-words gate scans this folder. */
export const WHALES_COPY = {
  title: "Whale moves",
  pitch: "Know when whales run before you do.",
  help: "A move counts when it is at least $250,000 or 2% of the vault, whichever is more.",
  reading: "Reading recent moves…",
  none: "No big moves on this vault lately.",
  failed: "Could not read whale moves right now.",
  bot: "Follow this vault in the Telegram bot to hear about each one as it happens.",
  left: "left",
  entered: "moved into",
  ofVault: "of the vault",
  liquid: "idle in the vault",
  viewTx: "View the transaction",
} as const;
