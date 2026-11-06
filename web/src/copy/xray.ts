/** Wording for the X-ray page and its share links, here so the banned-words gate can check it. Facts only. */

export const SITE = "canopyrh.com";
export const PITCH = "X-ray your vault before it X-rays you.";

export const XRAY_COPY = {
  title: "Vault X-ray",
  intro: "Paste a vault address to see how liquid it is now, who can change what, and what is armed on it. The card is read from the chain.",
  inputLabel: "Vault address",
  placeholder: "Vault address (0x...)",
  button: "X-ray it",
  or: "Or start with a listed vault:",
  post: "Post on X",
  copy: "Copy link",
  copied: "Link copied",
  copyFailed: "Copy didn't work. The link is shown below.",
  loading: "Drawing the card...",
  badAddress: "That is not a vault address. It should start with 0x and have 40 more characters.",
  unknown: "Canopy has no card for this vault yet.",
  unavailable: "X-ray cards are not available on this site.",
  failed: "Couldn't load the card just now. Try again in a moment.",
  alt: "X-ray card for this vault",
  note: "Facts read from the chain. Not advice, and no promise about any outcome.",
  openApp: "Check your own wallet",
};

/** The 280-character limit counts a link as 23, so the text keeps well clear of it. */
const MAX_TEXT = 230;

export interface ShareFacts {
  summary: string;
}

/** What the Post on X button prefills. The card itself arrives as the link's preview image. */
export function shareText(f: ShareFacts): string {
  const tail = `\n\n${PITCH} ${SITE}`;
  const room = MAX_TEXT - tail.length;
  const head = f.summary.length > room ? `${f.summary.slice(0, room - 3).trimEnd()}...` : f.summary;
  return `${head}${tail}`;
}

export const VAULT_PARAM = /^0x[0-9a-fA-F]{40}$/;

/** The link to a vault's share page on the API, whose meta tags carry the card as the preview image. */
export const shareUrl = (apiUrl: string, vault: string) => `${apiUrl.replace(/\/+$/, "")}/xray/${vault.toLowerCase()}`;

export const imageUrl = (apiUrl: string, vault: string) => `${shareUrl(apiUrl, vault)}.png`;

export const intentUrl = (text: string, url: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
