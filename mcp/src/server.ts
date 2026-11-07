import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { CanopyError, createCanopy, toJson, type Canopy } from "../../sdk/src/index";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const owner = address.describe("The position owner's wallet. This server cannot sign for it.");
const vault = address.describe("A listed ERC-4626 vault on the configured chain.");
const position = z.strictObject({ owner, vault });
const arm = z.strictObject({ owner, vault, keys: z.array(hash).min(1).max(8).describe("Keys returned by list_alarms. For tighten, only the additional keys are needed.") });

/** Strict input schemas exclude recipient, router, API URL, arbitrary calldata and private keys. */
export function createServer(canopy: Canopy = createCanopy()) {
  const server = new McpServer({ name: "canopy", version: "0.1.0" });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const result = async (run: () => Promise<unknown>) => {
    try {
      const value = JSON.parse(toJson(await run())) as Record<string, unknown>;
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
    } catch (e) {
      // RPC error messages can contain a provider URL/API key. Only our own bounded errors cross the tool boundary.
      const error = e instanceof CanopyError ? { code: e.code, message: e.message } : { code: "read_failed", message: "The chain read failed. Check the configured RPC and try again." };
      return { content: [{ type: "text" as const, text: JSON.stringify(error) }], isError: true };
    }
  };
  server.registerTool("check_wallet", { description: "Read balances and arming state for listed vaults. Reports incomplete reads explicitly. Does not scan all DeFi positions.", inputSchema: z.strictObject({ owner }), annotations }, ({ owner }) => result(() => canopy.checkWallet(owner)));
  server.registerTool("explain_position", { description: "Explain current on-chain vault facts, liquidity and alarms, with block references and unknowns. Does not rate safety or choose alarms.", inputSchema: position, annotations }, ({ owner, vault }) => result(() => canopy.explainPosition(owner, vault)));
  server.registerTool("list_alarms", { description: "Read this vault's app presets and whether each can currently be armed.", inputSchema: z.strictObject({ vault }), annotations }, ({ vault }) => result(() => canopy.listAlarms(vault)));
  server.registerTool("arm_position", { description: "Prepare unsigned registration, approval and arming transactions for a new position. The owner must review the included terms and approve in their wallet. Nothing is sent.", inputSchema: arm, annotations }, ({ owner, vault, keys }) => result(() => canopy.armPosition(owner, vault, keys)));
  server.registerTool("tighten", { description: "Prepare an owner-approved proposal adding preset alarms, preserving all existing keys and payout settings read at this block. This does not provide an enforced session-key permission. Nothing is sent.", inputSchema: arm, annotations }, ({ owner, vault, keys }) => result(() => canopy.tighten(owner, vault, keys)));
  server.registerTool("exit_now", { description: "Simulate and prepare an unsigned owner exit, including for a previously disarmed position. No fee or live alarm is required. The owner must sign. Nothing is sent.", inputSchema: position, annotations }, ({ owner, vault }) => result(() => canopy.exitNow(owner, vault)));
  server.registerTool("exit_receipt", { description: "Read an exit receipt directly from the configured chain using the existing Canopy receipt reader.", inputSchema: z.strictObject({ hash }), annotations }, ({ hash }) => result(() => canopy.exitReceipt(hash)));
  return server;
}
