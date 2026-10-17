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

/** Reads every listed vault for one wallet. `failed` means the list may be missing positions. */
export async function scanWallet(owner: Address): Promise<{ found: Position[]; failed: boolean }> {
  let failed = false;
  const read = (v: Vault) => position(v, owner).catch(() => {
    failed = true;
    return null;
  });
  const found = (await Promise.all(CONFIG.vaults.map(read))).filter((x) => x !== null);
  return { found, failed };
}

/** Fetches every listed card once, so the API can't tell which vaults a wallet holds. */
let cards: Promise<Map<string, string | null>> | null = null;
export function riskCard(vault: Address) {
  cards ??= Promise.all(
    CONFIG.vaults.map(async (v) => {
      const r = await fetch(`${CONFIG.apiUrl}/risk/${v.address}`).catch(() => null);
      const body = r?.ok ? ((await r.json().catch(() => null)) as { text: string } | null) : null;
      return [v.address.toLowerCase(), body?.text ?? null] as const;
    }),
  ).then((list) => new Map(list));
  return cards.then((m) => m.get(vault.toLowerCase()) ?? null);
}

/** The router's id for an owner's vault position, and whether it is armed. Null when no contracts are set. */
export async function armState(owner: Address, vault: Address): Promise<{ posId: Hex; armed: boolean } | null> {
  if (!live()) return null;
  const posId = await client.readContract({ address: CONFIG.router!, abi: routerAbi, functionName: "positionId", args: [owner, CONFIG.adapter!, vault, 0n] });
  const armed = await client.readContract({ address: CONFIG.router!, abi: routerAbi, functionName: "isArmed", args: [posId] });
  return { posId, armed };
}

export interface PresetView { preset: Preset; tripped: boolean }

/** The presets this vault can use. Worked out here, not fetched, so a compromised server can't swap in different alarm keys. */
export async function presetViews(vault: Address): Promise<PresetView[]> {
  const views = await Promise.all(presetsFor(vault).map(async (preset): Promise<PresetView | null> => {
    // Many vaults have no pause switch, so that alarm could never fire there.
    if (preset.detector.kind === Kind.PAUSED) {
      const ok = await client.readContract({ address: vault, abi: pausedAbi, functionName: "paused" }).then(() => true, () => false);
      if (!ok) return null;
    }
    // A tripped alarm could exit this position at any moment, for something that happened before the owner arrived.
    const tripped = await Promise.all([
      client.readContract({ address: CONFIG.alarmBook!, abi: alarmBookAbi, functionName: "check", args: [preset.key] }),
      client.readContract({ address: CONFIG.alarmBook!, abi: alarmBookAbi, functionName: "isLive", args: [preset.key, 86_400n] }),
    ]).then(([t, f]) => t || f, () => false);
    return { preset, tripped };
  }));
  return views.filter((v) => v !== null);
}
