# Canopy MCP

A local, keyless stdio server exposing `check_wallet`, `explain_position`, `list_alarms`, `arm_position`, `tighten`,
`exit_now` and `exit_receipt`. It calls the [existing-code SDK](../sdk/README.md); it does not run a keeper or accept
wallet keys. Transaction tools return unsigned proposals requiring the owner's review and wallet approval.
There is no disarm tool, HTTP listener, database, fee collection or telemetry.

Install the SDK's repository dependencies first as described in its README, then:

```sh
cd mcp
bun install --frozen-lockfile
bun test
bun run typecheck
bun run start
```

The running command waits on stdin. Configure it in an MCP host using the host's stdio server settings:

```json
{
  "mcpServers": {
    "canopy": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/canopy/mcp/src/index.ts"],
      "env": { "CANOPY_CHAIN_ID": "4663" }
    }
  }
}
```

Use your own absolute paths. `CANOPY_RPC_URL` is an optional locally configured RPC override. The chain must have
a live deployment in the app configuration, and the RPC must report that chain ID. Base is currently refused.
Never put private keys or seed phrases in this configuration. The host sees tool arguments/results; the RPC sees
wallet reads. API-provider errors are redacted so credential-bearing RPC URLs do not enter tool results.

Input schemas reject extra properties: callers cannot supply a recipient, router, RPC URL, arbitrary calldata or
private key through a tool. The seven tools only read and build unsigned data, so their MCP annotations are read-only.
`tighten` preserves the settings observed at its read block; it does not grant or enforce a session-key permission.
See the SDK's transaction review and concurrency limits before connecting a wallet executor.

The server uses the official [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio).
The transport tests cover negotiation, listing, validation, bigint serialization, error redaction and the real executable.

## Research suite

Ten additional read-only/local research tools are included. See [the launch guide](../docs/research-launch.md) for methods, input formats, deployment and verification. Existing transaction-preparation tools retain their original owner-review boundary.
