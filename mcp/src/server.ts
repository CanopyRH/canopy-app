import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  CanopyError,
  createCanopy,
  toJson,
  type Canopy,
} from "../../sdk/src/index";
import { createObservatory, type Observatory } from "../../sdk/src/research";
import type { Address, Hex } from "../../sdk/src/research";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const owner = address.describe(
  "The position owner's wallet. This server cannot sign for it.",
);
const vault = address.describe(
  "A listed ERC-4626 vault on the configured chain.",
);
const position = z.strictObject({ owner, vault });
const arm = z.strictObject({
  owner,
  vault,
  keys: z
    .array(hash)
    .min(1)
    .max(8)
    .describe(
      "Keys returned by list_alarms. For tighten, only the additional keys are needed.",
    ),
});

/** Strict input schemas exclude recipient, router, API URL, arbitrary calldata and private keys. */
export function createServer(
  canopy: Canopy = createCanopy(),
  research: Observatory = createObservatory(),
) {
  const server = new McpServer({ name: "canopy", version: "0.1.0" });
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
  const result = async (run: () => Promise<unknown>) => {
    try {
      const value = JSON.parse(toJson(await run())) as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredContent: value,
      };
    } catch (e) {
      // RPC error messages can contain a provider URL/API key. Only our own bounded errors cross the tool boundary.
      const error =
        e instanceof CanopyError
          ? { code: e.code, message: e.message }
          : {
              code: "read_failed",
              message:
                "The chain read failed. Check the configured RPC and try again.",
            };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(error) }],
        isError: true,
      };
    }
  };
  server.registerTool(
    "check_wallet",
    {
      description:
        "Read balances and arming state for listed vaults. Reports incomplete reads explicitly. Does not scan all DeFi positions.",
      inputSchema: z.strictObject({ owner }),
      annotations,
    },
    ({ owner }) => result(() => canopy.checkWallet(owner)),
  );
  server.registerTool(
    "explain_position",
    {
      description:
        "Explain current on-chain vault facts, liquidity and alarms, with block references and unknowns. Does not rate safety or choose alarms.",
      inputSchema: position,
      annotations,
    },
    ({ owner, vault }) => result(() => canopy.explainPosition(owner, vault)),
  );
  server.registerTool(
    "list_alarms",
    {
      description:
        "Read this vault's app presets and whether each can currently be armed.",
      inputSchema: z.strictObject({ vault }),
      annotations,
    },
    ({ vault }) => result(() => canopy.listAlarms(vault)),
  );
  server.registerTool(
    "arm_position",
    {
      description:
        "Prepare unsigned registration, approval and arming transactions for a new position. The owner must review the included terms and approve in their wallet. Nothing is sent.",
      inputSchema: arm,
      annotations,
    },
    ({ owner, vault, keys }) =>
      result(() => canopy.armPosition(owner, vault, keys)),
  );
  server.registerTool(
    "tighten",
    {
      description:
        "Prepare an owner-approved proposal adding preset alarms, preserving all existing keys and payout settings read at this block. This does not provide an enforced session-key permission. Nothing is sent.",
      inputSchema: arm,
      annotations,
    },
    ({ owner, vault, keys }) =>
      result(() => canopy.tighten(owner, vault, keys)),
  );
  server.registerTool(
    "exit_now",
    {
      description:
        "Simulate and prepare an unsigned owner exit, including for a previously disarmed position. No fee or live alarm is required. The owner must sign. Nothing is sent.",
      inputSchema: position,
      annotations,
    },
    ({ owner, vault }) => result(() => canopy.exitNow(owner, vault)),
  );
  server.registerTool(
    "exit_receipt",
    {
      description:
        "Read an exit receipt directly from the configured chain using the existing Canopy receipt reader.",
      inputSchema: z.strictObject({ hash }),
      annotations,
    },
    ({ hash }) => result(() => canopy.exitReceipt(hash)),
  );
  for (const tool of ["oracles", "controls", "concentration"] as const)
    server.registerTool(
      `research_${tool}`,
      {
        description: `Read ${tool} facts for one listed vault, with block provenance and explicit coverage limits. No safety rating or transaction.`,
        inputSchema: z.strictObject({ vault }),
        annotations,
      },
      ({ vault }) => result(() => research[tool](vault)),
    );
  server.registerTool(
    "research_liquidity",
    {
      description:
        "Rehearse hypothetical withdrawal pressure against idle assets; optionally inspect one owner's maxWithdraw. No simulation guarantee or transaction.",
      inputSchema: z.strictObject({ vault, owner: address.optional() }),
      annotations,
    },
    ({ vault, owner }) => result(() => research.liquidity(vault, owner)),
  );
  server.registerTool(
    "research_perps",
    {
      description:
        "Read RH Lighter market gaps and optional owner-bound positions. Owner and account must be supplied together. No trading key or orders.",
      inputSchema: z.strictObject({
        owner: address.optional(),
        account: z
          .string()
          .regex(/^\d{1,15}$/)
          .optional(),
      }),
      annotations,
    },
    ({ owner, account }) => result(() => research.perps(owner, account)),
  );
  server.registerTool(
    "research_funding",
    {
      description:
        "Read venue-labelled reference funding rates. Timestamps and comparable intervals are not provided; do not annualize or label all rows Lighter.",
      inputSchema: z.strictObject({}),
      annotations,
    },
    () => result(() => research.funding()),
  );
  server.registerTool(
    "research_sessions",
    {
      description:
        "Analyze a user-supplied reviewed UTC session calendar and feed observation. A local planning calculation, not permission to trade.",
      inputSchema: z.strictObject({ input: z.unknown() }),
      annotations,
    },
    ({ input }) => result(async () => research.sessions(input)),
  );
  const expected = z.strictObject({
    chainId: z
      .number()
      .int()
      .positive()
      .max(2 ** 32 - 1),
    alarmBook: address,
    approved: z.array(address).min(1).max(32),
  });
  server.registerTool(
    "research_evidence",
    {
      description:
        "Verify a watcher archive signature, shared report hashes and expected approval list locally. Does not establish report truth or a quorum.",
      inputSchema: z.strictObject({ bundle: z.unknown(), expected }),
      annotations,
    },
    ({ bundle, expected }) =>
      result(() =>
        research.evidence(bundle, {
          ...expected,
          alarmBook: expected.alarmBook as Address,
          approved: expected.approved as Address[],
        }),
      ),
  );
  server.registerTool(
    "research_heartbeat",
    {
      description:
        "Verify an expiring agent heartbeat against the expected key, scope, chain, contract and prior sequence. Does not prove correct operation or authorize funds.",
      inputSchema: z.strictObject({
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
      annotations,
    },
    ({ bundle, expected }) =>
      result(() =>
        research.heartbeat(bundle, {
          ...expected,
          alarmBook: expected.alarmBook as Address,
          agent: expected.agent as Address,
          scope: expected.scope as Hex,
        }),
      ),
  );
  server.registerTool(
    "research_changes",
    {
      description:
        "Compare two compatible exported observations locally. Rejects different subjects and conflicting block hashes. Imported facts are not authenticated.",
      inputSchema: z.strictObject({ before: z.unknown(), after: z.unknown() }),
      annotations,
    },
    ({ before, after }) => result(async () => research.changes(before, after)),
  );
  return server;
}
