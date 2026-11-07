import type { Address, PublicClient } from "viem";
import { address, ObservatoryError, observe } from "./core";
import { oracleLens } from "./oracles";
import { controlMap } from "./controls";
import { concentration } from "./concentration";
import { liquidityLab } from "./liquidity";
import { perpsRadar } from "./perps";
import { fundingWatch } from "./funding";
import { parseResearchQuery } from "./query";
export const LIVE_FEATURES = [
  "oracles",
  "controls",
  "concentration",
  "liquidity",
  "perps",
  "funding",
] as const;
export type LiveFeature = (typeof LIVE_FEATURES)[number];
export type ResearchQuery = {
  vault?: string;
  owner?: string;
  account?: string;
};
export type ResearchProvider = (
  feature: LiveFeature,
  q: ResearchQuery,
) => Promise<unknown>;
export const FEATURES = [
  {
    id: "oracles",
    title: "Oracle Lens",
    mode: "live",
    summary:
      "Inspect the price sources behind a vault's markets, including visible feed rounds and unknowns.",
  },
  {
    id: "controls",
    title: "Control Map",
    mode: "live",
    summary:
      "See owner and curator addresses, code fingerprints, delegation and standard proxy slots at one block.",
  },
  {
    id: "concentration",
    title: "Exposure Concentration",
    mode: "live",
    summary:
      "Find collateral, oracle and rate-model dependencies shared by known vault allocations.",
  },
  {
    id: "liquidity",
    title: "Liquidity Stress Lab",
    mode: "live",
    summary:
      "Compare hypothetical withdrawal demand with idle assets and an optional owner's withdrawal limit.",
  },
  {
    id: "perps",
    title: "Perps Radar",
    mode: "live",
    summary:
      "Inspect RH Lighter mark/reference gaps, venue states and optional owner-bound liquidation distances.",
  },
  {
    id: "funding",
    title: "Funding Watch",
    mode: "live",
    summary:
      "Read venue-labelled funding references without mixing exchanges or inventing comparable intervals.",
  },
  {
    id: "sessions",
    title: "Session Planner",
    mode: "local",
    summary:
      "Check a reviewed UTC calendar and export pre-close review reminders to your calendar app.",
  },
  {
    id: "evidence",
    title: "Evidence Verifier",
    mode: "local",
    summary:
      "Check an archived watcher's signature, domain and signed evidence against an expected approval list.",
  },
  {
    id: "heartbeat",
    title: "Agent Liveness",
    mode: "local",
    summary:
      "Verify expiring, scope-bound agent heartbeats and reject stale or replayed sequences.",
  },
  {
    id: "changes",
    title: "Change Monitor",
    mode: "local",
    summary:
      "Compare saved observations, inspect changed fields and watch for changes while this tab is open.",
  },
] as const;
export function createResearch(
  client: PublicClient,
  config: { chainId: number; vaults: readonly string[]; now?: () => number },
): ResearchProvider {
  return async (feature, q) => {
    q = parseResearchQuery(
      feature,
      Object.entries(q).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    );
    const now = config.now?.() ?? Math.floor(Date.now() / 1000);
    if (feature === "perps" || feature === "funding") {
      if (config.chainId !== 4663)
        throw new ObservatoryError(
          "unsupported_chain",
          "RH Lighter tools are available on Robinhood Chain only.",
        );
      return feature === "funding"
        ? fundingWatch(undefined, config.now?.())
        : perpsRadar(
            undefined,
            q.owner ? address(q.owner) : undefined,
            q.account === undefined ? undefined : Number(q.account),
            config.now?.(),
          );
    }
    const vault = address(q.vault ?? "");
    if (!config.vaults.some((v) => v.toLowerCase() === vault.toLowerCase()))
      throw new ObservatoryError(
        "unlisted_vault",
        "Choose a vault listed by this deployment.",
      );
    const o = await observe(client, config.chainId, now);
    switch (feature) {
      case "oracles":
        return oracleLens(o, vault);
      case "controls":
        return controlMap(o, vault);
      case "concentration":
        return concentration(o, vault);
      case "liquidity":
        return liquidityLab(o, vault, q.owner ? address(q.owner) : undefined);
    }
  };
}
