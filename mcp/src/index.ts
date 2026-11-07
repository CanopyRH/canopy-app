import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createCanopy } from "../../sdk/src/index";
import { createServer } from "./server";

// Local stdio only. No HTTP listener, wallet key, telemetry, database or Canopy API dependency.
const chainId = Number(process.env.CANOPY_CHAIN_ID ?? "4663");
try {
  const canopy = createCanopy({ chainId, rpcUrl: process.env.CANOPY_RPC_URL });
  await serveStdio(() => createServer(canopy));
} catch {
  // Do not print RPC URLs, which may contain credentials.
  console.error("Canopy MCP could not start. Check CANOPY_CHAIN_ID and CANOPY_RPC_URL.");
  process.exitCode = 1;
}
