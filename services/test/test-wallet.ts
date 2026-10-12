/**
 * A local stand-in for a browser wallet, for trying the web app on Base Sepolia. It signs with the throwaway test user key.
 * Run from services/: ../.tools/bun/v1.4.4/bun test/test-wallet.ts
 * Then in the page: window.ethereum = { request: (a) => fetch("http://127.0.0.1:4174", { method: "POST", body: JSON.stringify(a) }).then((r) => r.json()).then((r) => { if (r.error) throw new Error(r.error); return r.result; }) };
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const RPC = process.env.RPC_URL ?? "https://sepolia.base.org";
const keys = JSON.parse(readFileSync(join(import.meta.dir, "../../deploy/testnet/keys.json"), "utf8")) as { user: Hex };
const account = privateKeyToAccount(keys.user);
const client = createPublicClient({ chain: baseSepolia, transport: http(RPC), pollingInterval: 500, cacheTime: 0 });
const wallet = createWalletClient({ chain: baseSepolia, transport: http(RPC), account, pollingInterval: 500 });
if ((await client.getChainId()) !== baseSepolia.id) throw new Error("this RPC is not Base Sepolia");

let chain = "0x1"; // Starts on the wrong network, so the page has to ask to switch.
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };

Bun.serve({
  port: 4174,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const { method, params } = (await req.json()) as { method: string; params?: { to: Hex; data: Hex }[] };
    try {
      if (method === "eth_requestAccounts") return Response.json({ result: [account.address] }, { headers: cors });
      if (method === "eth_chainId") return Response.json({ result: chain }, { headers: cors });
      if (method === "wallet_switchEthereumChain") {
        chain = (params![0] as unknown as { chainId: string }).chainId;
        return Response.json({ result: null }, { headers: cors });
      }
      if (method === "eth_sendTransaction") {
        const { to, data } = params![0]!;
        // Answers as soon as it's sent, like a real wallet, so the page has to wait for the receipt itself.
        const hash = await wallet.sendTransaction({ to, data });
        console.log("sent", to, hash);
        return Response.json({ result: hash }, { headers: cors });
      }
      return Response.json({ error: `unsupported: ${method}` }, { headers: cors });
    } catch (e) {
      return Response.json({ error: (e as Error).message.slice(0, 300) }, { headers: cors });
    }
  },
});
console.log(`test wallet ${account.address} on http://127.0.0.1:4174`);
