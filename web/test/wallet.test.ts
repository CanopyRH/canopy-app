import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { COPY } from "../src/copy/text";
import { friendly, safeIcon, sendTx, walletChoice, watchWallets, type Eip1193, type FoundWallet } from "../src/wallet";

const FROM = "0x00000000000000000000000000000000000000a1" as Address;
const TX = { to: "0x00000000000000000000000000000000000000a2" as Address, data: "0x12" as Hex };
const HASH = `0x${"ab".repeat(32)}` as Hex;
const NET = { chainHex: "0x1237", chainName: "Robinhood Chain", rpcUrl: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com" };

/** knows: the wallet already has the network. adds: it accepts a request to add it. */
function wallet(start: string, switches = true, knows = true, adds = true) {
  let chain = start;
  let known = knows;
  const calls: string[] = [];
  const added: unknown[] = [];
  const w: Eip1193 = {
    request: async ({ method, params }) => {
      calls.push(method);
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") {
        if (!switches) throw Object.assign(new Error("user rejected"), { code: 4001 });
        if (!known) throw Object.assign(new Error("unrecognized chain"), { code: 4902 });
        chain = (params![0] as { chainId: string }).chainId;
        return null;
      }
      if (method === "wallet_addEthereumChain") {
        added.push(params![0]);
        if (!adds) throw new Error("refused");
        known = true;
        chain = (params![0] as { chainId: string }).chainId;
        return null;
      }
      return HASH;
    },
  };
  return { w, calls, added };
}
const mined = (status: string, replaced?: string) => ({
  waitForTransactionReceipt: async (a: { onReplaced?: (r: { reason: string }) => void }) => {
    if (replaced) a.onReplaced?.({ reason: replaced });
    return { status };
  },
});
