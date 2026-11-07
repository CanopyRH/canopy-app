import { createPublicClient, http, type Address } from "viem";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { discoverBorrowing } from "./borrower/morpho";
import { prepareBorrowRepayment } from "./borrower/prepare";
import { BorrowPolicy } from "./borrower/plan";
import { lookThrough } from "./risk/lookthrough";
import { explainExposure } from "./copilot/explain";
import { lighterClient } from "./perps/lighter";
import { IdentityRequest, prepareIdentity } from "./agents/erc8004";
import { Calendar } from "./rwa/session";
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v as Address);
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v as `0x${string}`);
const chainId = z
  .number()
  .int()
  .positive()
  .max(2 ** 32 - 1);
const session = z.strictObject({
  calendar: Calendar,
  feed: z.strictObject({
    updatedAt: z.number().int().nonnegative(),
    heartbeat: z.number().int().positive(),
    positive: z.boolean(),
    paused: z.boolean().nullable(),
  }),
  multiplierChanged: z.boolean(),
});
export const ExpansionRequest = z.discriminatedUnion("command", [
  IdentityRequest.extend({ command: z.literal("identity-prepare") }),
  z.strictObject({ command: z.literal("exposure"), chainId, root: address }),
  z.strictObject({
    command: z.literal("borrow-discover"),
    chainId,
    morpho: address,
    owner: address,
    markets: z.array(z.strictObject({ id: hash, health: address })).max(64),
  }),
  z.strictObject({
    command: z.literal("borrow-prepare"),
    chainId,
    guard: address,
    owner: address,
    morpho: address,
    alarmBook: address,
    market: hash,
    health: address,
    executor: address,
    policy: BorrowPolicy,
    session: session.optional(),
  }),
  z.strictObject({
    command: z.literal("lighter-discover"),
    owner: address,
    cursor: z.string().min(1).max(512).optional(),
  }),
  z.strictObject({
    command: z.literal("lighter-account"),
    owner: address,
    account: z
      .number()
      .int()
      .min(0)
      .max(2 ** 48 - 1),
  }),
]);
/** Read-only operator entry point. Never loads a wallet, accepts a key or broadcasts calldata. */
export async function runExpansion(raw: unknown, rpcUrl?: string) {
  const r = ExpansionRequest.parse(raw);
  if (r.command === "lighter-discover")
    return lighterClient().discover(r.owner, r.cursor);
  if (r.command === "lighter-account")
    return lighterClient().account(r.account, r.owner);
  if (!rpcUrl)
    throw new Error("CANOPY_EXPANSION_RPC_URL is required for chain reads");
  const url = new URL(rpcUrl);
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("Invalid RPC transport");
  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: 4000, retryCount: 0 }),
  });
  if ((await client.getChainId()) !== r.chainId)
    throw new Error("Wrong RPC chain");
  if (r.command === "identity-prepare") {
    const { command, ...request } = r;
    return prepareIdentity(client, request);
  }
  if (r.command === "exposure") {
    const block = await client.getBlock();
    const graph = await lookThrough(client, r.root, block.number);
    return { graph, explanation: explainExposure(graph) };
  }
  if (r.command === "borrow-discover")
    return discoverBorrowing(client, r.chainId, r.morpho, r.owner, r.markets);
  return prepareBorrowRepayment(client, r, r.executor, r.policy, r.session);
}
if (import.meta.main) {
  try {
    const path = process.argv[2];
    if (!path || process.argv.length !== 3)
      throw new Error("Usage: bun src/expansion-cli.ts request.json");
    if ((await stat(path)).size > 65536)
      throw new Error("Request exceeds 64 KiB");
    const result = await runExpansion(
      JSON.parse(await readFile(path, "utf8")),
      process.env.CANOPY_EXPANSION_RPC_URL,
    );
    console.log(
      JSON.stringify(
        result,
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
        2,
      ),
    );
  } catch {
    // RPC exceptions may contain authenticated endpoint URLs. Keep stderr credential-free.
    console.error(
      "Expansion request failed. Check the request schema, reviewed configuration and RPC availability; no transaction was sent.",
    );
    process.exitCode = 1;
  }
}
