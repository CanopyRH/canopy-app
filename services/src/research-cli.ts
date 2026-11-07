import { readFile, stat } from "node:fs/promises";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { z } from "zod";
import { CONFIG } from "../../web/src/config";
import { createResearch, LIVE_FEATURES } from "./observatory";
import { parseResearchQuery } from "./plugins/observatory";
import { serial } from "./observatory/core";
import { sessionPlan, sessionIcs } from "./observatory/sessions";
import { verifyEvidence } from "./observatory/evidence";
import { verifyHeartbeat } from "./observatory/heartbeat";
import { compareReports } from "./observatory/changes";
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const ResearchRequest = z.discriminatedUnion("command", [
  z.strictObject({
    command: z.enum(LIVE_FEATURES),
    query: z.record(z.string(), z.string()).default({}),
  }),
  z.strictObject({
    command: z.literal("sessions"),
    input: z.unknown(),
    calendarExport: z.boolean().default(false),
  }),
  z.strictObject({
    command: z.literal("evidence"),
    bundle: z.unknown(),
    expected: z.strictObject({
      chainId: z
        .number()
        .int()
        .positive()
        .max(2 ** 32 - 1),
      alarmBook: address,
      approved: z.array(address).min(1).max(32),
    }),
  }),
  z.strictObject({
    command: z.literal("heartbeat"),
    bundle: z.unknown(),
    expected: z.strictObject({
      chainId: z
        .number()
        .int()
        .positive()
        .max(2 ** 32 - 1),
      alarmBook: address,
      agent: address,
      scope: hash,
      lastSequence: z
        .string()
        .regex(/^(0|[1-9]\d{0,19})$/)
        .nullable(),
    }),
  }),
  z.strictObject({
    command: z.literal("changes"),
    before: z.unknown(),
    after: z.unknown(),
  }),
]);
export async function researchCommand(raw: unknown) {
  const r = ResearchRequest.parse(raw);
  if (r.command === "sessions")
    return r.calendarExport
      ? { report: sessionPlan(r.input), ics: sessionIcs(r.input) }
      : sessionPlan(r.input);
  if (r.command === "evidence")
    return verifyEvidence(r.bundle, {
      ...r.expected,
      alarmBook: r.expected.alarmBook as Address,
      approved: r.expected.approved as Address[],
    });
  if (r.command === "heartbeat")
    return verifyHeartbeat(r.bundle, {
      ...r.expected,
      alarmBook: r.expected.alarmBook as Address,
      agent: r.expected.agent as Address,
      scope: r.expected.scope as Hex,
    });
  if (r.command === "changes") return compareReports(r.before, r.after);
  const query = parseResearchQuery(r.command, Object.entries(r.query));
  const client = createPublicClient({
    transport: http(process.env.CANOPY_RESEARCH_RPC_URL ?? CONFIG.rpcUrl, {
      timeout: 4000,
      retryCount: 0,
    }),
  });
  return createResearch(client, {
    chainId: CONFIG.chainId,
    vaults: CONFIG.vaults.map((v) => v.address),
  })(r.command, query);
}
if (import.meta.main) {
  try {
    const path = process.argv[2];
    if (!path || (await stat(path)).size > 2_000_000) throw new Error();
    console.log(
      JSON.stringify(
        serial(await researchCommand(JSON.parse(await readFile(path, "utf8")))),
        null,
        2,
      ),
    );
  } catch {
    console.error(
      "Research request failed. Check the documented input and source availability; no transaction was signed or sent.",
    );
    process.exitCode = 1;
  }
}
