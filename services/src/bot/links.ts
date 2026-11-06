import { isAddress } from "viem";

/**
 * Deep links into the web app. The fragment names a vault or an action and nothing else: no wallet, no amount.
 * The app reads the fragment in the browser, so it never reaches a server, and the user's own wallet does the signing.
 */
function withFragment(appUrl: string, fragment: string): string {
  const u = new URL(appUrl);
  u.hash = fragment;
  return u.toString();
}

const vaultFragment = (kind: "exit" | "risk", vault: string) => {
  if (!isAddress(vault, { strict: false })) throw new Error("not a vault address");
  return `${kind}=${vault.toLowerCase()}`;
};

export const exitLink = (appUrl: string, vault: string) => withFragment(appUrl, vaultFragment("exit", vault));
export const riskLink = (appUrl: string, vault: string) => withFragment(appUrl, vaultFragment("risk", vault));
export const disarmAllLink = (appUrl: string) => withFragment(appUrl, "disarm-all");
