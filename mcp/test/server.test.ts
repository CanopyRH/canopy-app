import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { createServer } from "../src/server";
import { CanopyError, type Canopy } from "../../sdk/src/index";

const owner = "0xabababababababababababababababababababab";
const vault = "0xbeeff033f34c046626b8d0a041844c5d1a5409dd";
const names = ["arm_position", "check_wallet", "exit_now", "exit_receipt", "explain_position", "list_alarms", "tighten", ...["oracles","controls","concentration","liquidity","perps","funding","sessions","evidence","heartbeat","changes"].map(n=>"research_"+n)].sort();

async function harness(sdk: Partial<Canopy> = {}, research?: Parameters<typeof createServer>[1]) {
  const server = createServer(sdk as Canopy,research);
  const [client, transport] = InMemoryTransport.createLinkedPair();
  let id = 0;
  const waiting = new Map<number, (value: Record<string, unknown>) => void>();
  client.onmessage = (message) => {
    if ("id" in message && typeof message.id === "number") {
      const resolve = waiting.get(message.id);
      waiting.delete(message.id);
      resolve?.(message as unknown as Record<string, unknown>);
    }
  };
  await client.start();
  await server.connect(transport);
  async function request(method: string, params: Record<string, unknown> = {}) {
    const n = ++id;
    const answer = new Promise<Record<string, unknown>>((resolve) => waiting.set(n, resolve));
    await client.send({ jsonrpc: "2.0", id: n, method, params } as JSONRPCMessage);
    return answer;
  }
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "canopy-tests", version: "1" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { request, close: () => server.close() };
}

test("MCP handshake advertises the seven existing tools and ten research tools, with strict schemas", async () => {
  const h = await harness();
  try {
    const answer = await h.request("tools/list");
    const tools = (answer.result as { tools: { name: string; inputSchema: { additionalProperties: boolean }; annotations: { readOnlyHint: boolean } }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(names);
    expect(tools.every((t) => t.inputSchema.additionalProperties === false && t.annotations.readOnlyHint)).toBe(true);
  } finally { await h.close(); }
});
test("MCP preserves big integers and rejects recipient/calldata injection before calling the SDK", async () => {
  let calls = 0;
  const h = await harness({ checkWallet: async () => { calls++; return { shares: 12345678901234567890123456789n } as never; } });
  try {
    const answer = await h.request("tools/call", { name: "check_wallet", arguments: { owner } });
    const result = answer.result as { structuredContent: { shares: string }; isError?: boolean };
    expect(result.structuredContent.shares).toBe("12345678901234567890123456789");
    for (const injected of [{ recipient: owner }, { data: "0xa9059cbb" }, { rpcUrl: "https://attacker.invalid" }, { privateKey: "secret" }]) {
      const rejected = await h.request("tools/call", { name: "check_wallet", arguments: { owner, ...injected } });
      expect(Boolean(rejected.error || (rejected.result as { isError?: boolean })?.isError)).toBe(true);
    }
    expect(calls).toBe(1);
  } finally { await h.close(); }
});
test("MCP sends only validated arguments to the unsigned builder and cannot disarm", async () => {
  const args: unknown[][] = [];
  const h = await harness({ armPosition: async (...a) => { args.push(a); return { kind: "unsigned", requiresOwnerApproval: true } as never; } });
  try {
    const keys = ["0x" + "aa".repeat(32)];
    const answer = await h.request("tools/call", { name: "arm_position", arguments: { owner, vault, keys } });
    expect((answer.result as { structuredContent: object }).structuredContent).toEqual({ kind: "unsigned", requiresOwnerApproval: true });
    expect(args).toEqual([[owner, vault, keys]]);
    const rejected = await h.request("tools/call", { name: "disarm", arguments: { owner, vault } });
    expect(Boolean(rejected.error || (rejected.result as { isError?: boolean })?.isError)).toBe(true);
  } finally { await h.close(); }
});
test("MCP redacts provider secrets and preserves actionable SDK errors", async () => {
  const h = await harness({
    checkWallet: async () => { throw new Error("https://rpc.invalid/private-secret"); },
    exitNow: async () => { throw new CanopyError("unknown_position", "Withdraw directly from the vault instead."); },
  });
  try {
    const answer = await h.request("tools/call", { name: "check_wallet", arguments: { owner } });
    expect(JSON.stringify(answer)).not.toContain("private-secret");
    expect((answer.result as { isError: boolean }).isError).toBe(true);
    expect(JSON.stringify(await h.request("tools/call", { name: "exit_now", arguments: { owner, vault } }))).toContain("unknown_position");
  } finally { await h.close(); }
});

test("the actual stdio executable starts and serves tools without keys, a database or RPC calls", async () => {
  const child = Bun.spawn([process.execPath, "src/index.ts"], { cwd: fileURLToPath(new URL("../", import.meta.url)), stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, CANOPY_CHAIN_ID: "4663" } });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function response(id: number) {
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line);
        if (message.id === id) return message;
      } else {
        const { value, done } = await reader.read();
        if (done) throw new Error("MCP exited before replying");
        buffer += decoder.decode(value, { stream: true });
      }
    }
  }
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } } }) + "\n");
    expect((await response(1)).result.serverInfo.name).toBe("canopy");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    expect((await response(2)).result.tools.map((t: { name: string }) => t.name).sort()).toEqual(names);
  } finally {
    clearTimeout(timeout); child.kill(); await child.exited; reader.releaseLock();
  }
}, 7000);

test("research tools pass only strict inputs, use the local verifier, and redact failures",async()=>{
  let calls=0;
  const research={controls:async(v:string)=>{calls++;return {vault:v,allocation:"999999999999999999999"};},funding:async()=>{throw new Error("private-provider-token");},changes:(a:unknown,b:unknown)=>({before:a,after:b})} as unknown as Parameters<typeof createServer>[1];
  const h=await harness({},research);
  try{
    const r=await h.request("tools/call",{name:"research_controls",arguments:{vault}});
    expect((r.result as any).structuredContent).toEqual({vault,allocation:"999999999999999999999"});
    for(const extra of [{apiUrl:"https://attacker.invalid"},{privateKey:"secret"}]){
      const r=await h.request("tools/call",{name:"research_controls",arguments:{vault,...extra}});
      expect(Boolean(r.error||(r.result as any)?.isError)).toBe(true);
    }
    expect(calls).toBe(1);
    const diff=await h.request("tools/call",{name:"research_changes",arguments:{before:{value:"1"},after:{value:"2"}}});
    expect((diff.result as any).structuredContent).toEqual({before:{value:"1"},after:{value:"2"}});
    const failed=await h.request("tools/call",{name:"research_funding",arguments:{}});
    expect((failed.result as any).isError).toBe(true);expect(JSON.stringify(failed)).not.toContain("private-provider-token");
  }finally{await h.close();}
});
