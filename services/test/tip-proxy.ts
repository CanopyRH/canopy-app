/**
 * Sits in front of a local fork and quotes the live chain's priority fee in place of Anvil's 1 gwei.
 * Usage: bun test/tip-proxy.ts <port> <anvil port> <tip as hex>
 */
const [port, upstream, tip] = process.argv.slice(2) as [string, string, string];

type RpcCall = { id: number; method: string };

Bun.serve({
  port: Number(port),
  async fetch(req) {
    const q = (await req.json()) as RpcCall | RpcCall[];
    // viem prefers this over its own fee estimate, and Anvil would fill in its 1 gwei tip.
    if (!Array.isArray(q) && q.method === "eth_fillTransaction") return Response.json({ jsonrpc: "2.0", id: q.id, error: { code: -32601, message: "method not found" } });
    const res = await fetch(`http://127.0.0.1:${upstream}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(q) });
    const r = (await res.json()) as { id: number } | { id: number }[];
    const fix = (x: { id: number }) => ([q].flat().find((c) => c.id === x.id)?.method === "eth_maxPriorityFeePerGas" ? { ...x, result: tip } : x);
    return Response.json(Array.isArray(r) ? r.map(fix) : fix(r));
  },
});
