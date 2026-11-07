import type { Address, Hex } from "viem";
export type { Address, Hex } from "viem";
export { heartbeatTyped } from "../../services/src/observatory/heartbeat";
import { CONFIG } from "../../web/src/config";
import { readResearch } from "../../web/src/research";
import {
  sessionPlan,
  sessionIcs,
} from "../../services/src/observatory/sessions";
import { verifyEvidence } from "../../services/src/observatory/evidence";
import { verifyHeartbeat } from "../../services/src/observatory/heartbeat";
import { compareReports } from "../../services/src/observatory/changes";
import type { LiveFeature } from "../../services/src/observatory";
export { sessionIcs };
/** No credentials, address persistence, signing or broadcasting. The API URL is operator configuration, not a tool argument. */
export function createObservatory(
  options: { apiUrl?: string; fetcher?: typeof fetch } = {},
) {
  const read = (feature: LiveFeature, q: Record<string, string> = {}) =>
    readResearch(
      options.apiUrl ?? CONFIG.apiUrl,
      feature,
      q,
      undefined,
      options.fetcher,
    );
  return {
    oracles: (vault: string) => read("oracles", { vault }),
    controls: (vault: string) => read("controls", { vault }),
    concentration: (vault: string) => read("concentration", { vault }),
    liquidity: (vault: string, owner?: string) =>
      read("liquidity", { vault, ...(owner ? { owner } : {}) }),
    perps: (owner?: string, account?: string) =>
      read("perps", {
        ...(owner ? { owner } : {}),
        ...(account !== undefined ? { account } : {}),
      }),
    funding: () => read("funding"),
    sessions: sessionPlan,
    evidence: (
      bundle: unknown,
      expected: { chainId: number; alarmBook: Address; approved: Address[] },
    ) => verifyEvidence(bundle, expected),
    heartbeat: (
      bundle: unknown,
      expected: {
        chainId: number;
        alarmBook: Address;
        agent: Address;
        scope: Hex;
        lastSequence: string | null;
      },
    ) => verifyHeartbeat(bundle, expected),
    changes: compareReports,
  };
}
export type Observatory = ReturnType<typeof createObservatory>;
