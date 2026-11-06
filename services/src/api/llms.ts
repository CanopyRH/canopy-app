export interface LlmsOptions {
  /** This API's address, without a trailing slash. */
  apiUrl: string;
  /** The website's address, when known. */
  siteUrl?: string;
  chain?: { chainId: number; router: string; adapter: string; alarmBook: string };
}

const CHAIN_NAMES: Record<number, string> = { 4663: "Robinhood Chain", 8453: "Base" };

/**
 * The plain-text brief for language models at /llms.txt. web/public/llms.txt is the same brief for the static site, and a test
 * keeps the two saying the same hard rules.
 */
export function buildLlmsTxt(o: LlmsOptions): string {
  const api = o.apiUrl.replace(/\/+$/, "");
  const docs = o.siteUrl ? `${o.siteUrl.replace(/\/+$/, "")}/agents.html` : "agents.html on the Canopy website";
  const chain = o.chain
    ? [
        `- Chain: ${CHAIN_NAMES[o.chain.chainId] ?? "chain"} (chain id ${o.chain.chainId})`,
        `- ExitRouter: ${o.chain.router}`,
        `- Adapter (ERC-4626 vaults): ${o.chain.adapter}`,
        `- AlarmBook: ${o.chain.alarmBook}`,
      ]
    : ["- This deployment has no Canopy contracts. It sends alerts only, and the calldata routes answer 503."];
  return [
    "# Canopy",
    "",
    "> Canopy is software that tries to exit a DeFi vault position when an alarm the owner chose fires. The owner arms a position, keepers watch the alarms, and an exit pays the owner's own wallet. It can fail, it promises no outcome and it does not cover losses.",
    "",
    "## Hard rules",
    "",
    "- There is no recipient field. The exit contract pays the position owner and nobody else. No API route takes a recipient.",
    "- Exit Now and Disarm All are free, always.",
    "- Agents can arm and tighten (add alarms). Only owners loosen (remove alarms) or disarm. Never give an agent the right to disarm.",
    "- Arming again replaces the position's keys, so an agent must send every key the position should keep, or it loosens the position.",
    "- The API only reads and builds calldata. It never signs, never takes a private key and never sends a transaction. The owner's wallet sends.",
    "- There is no external audit yet. The contracts have had internal reviews only.",
    "",
    "## API",
    "",
    `- Base URL: ${api}`,
    `- OpenAPI 3.1 spec: ${api}/openapi.json`,
    `- Docs for agent builders: ${docs}`,
    `- Reads are limited per client address; a 429 carries Retry-After.`,
    "",
    "Routes:",
    "",
    "- GET /vaults: the vaults Canopy covers",
    "- GET /risk/{vault}: a vault's risk card",
    "- GET /presets/{vault}: the alarm presets and their keys",
    "- GET /alarms/live: alarms that fired in the last day",
    "- GET /exits: the public exit log",
    "- GET /calldata/arm?vault=&keys=: approve and arm calls, after checking every key is registered and armable",
    "- GET /calldata/exit?vault=&owner=: the owner's Exit Now call",
    "- GET /calldata/disarm-all: the Disarm All call",
    "",
    "## Contracts",
    "",
    ...chain,
    "",
    "## Source",
    "",
    "- https://github.com/CanopyRH/canopy-app",
    "",
  ].join("\n");
}
