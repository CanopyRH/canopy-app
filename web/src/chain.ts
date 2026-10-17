import { createPublicClient, http, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { CONFIG, type Vault } from "./config";
import { exitBlocked, gateAbi, type Read } from "./gates";
import { sendTx, type Eip1193 } from "./wallet";
import { Kind, keyOf, presetsFor, registrationOrder, type Detector, type Preset } from "../../services/src/api/presets";
import { alarmBookAbi, approveTx, armTx, disarmAllTx, exitTx, planTx, registerTx, routerAbi, type Tx } from "./tx";

const vaultAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

const pausedAbi = parseAbi(["function paused() view returns (bool)"]);

export const client = createPublicClient({ transport: http(CONFIG.rpcUrl) });
export const live = () => Boolean(CONFIG.router && CONFIG.adapter && CONFIG.alarmBook);
const DUST = 10_000n; // $0.01 in 6-decimal stablecoins

export interface Position { vault: Vault; shares: bigint; assets: bigint }
/** A connected wallet, and a hook to tell the person what their wallet is waiting on. */
export interface Signer { provider: Eip1193; account: Address; onConfirm: () => void }

async function send(s: Signer, tx: Tx): Promise<Hex> {
  s.onConfirm();
  return sendTx(s.provider, client, s.account, tx, CONFIG);
}

async function position(v: Vault, owner: Address): Promise<Position | null> {
  const shares = await client.readContract({ address: v.address, abi: vaultAbi, functionName: "balanceOf", args: [owner] });
  if (shares === 0n) return null;
  const assets = await client.readContract({ address: v.address, abi: vaultAbi, functionName: "convertToAssets", args: [shares] });
  return assets < DUST ? null : { vault: v, shares, assets };
}
