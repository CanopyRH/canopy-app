import { createPublicClient, http, maxUint256, parseAbi, type Address, type Hex } from "viem";
import { autoExit, type Chain, type Vault } from "./config";
import { exitBlocked, gateAbi, type Read } from "./gates";
import { sendTx, type Eip1193 } from "./wallet";
import { keyOf, presetsFor, registrationOrder, type Detector, type Preset } from "../../services/src/api/presets";
import { notArmable, presetStatus, refusedPresets, type AlarmIo, type AlarmStatus } from "./alarms";
import { revertText } from "./errors";
import { COPY } from "./copy/text";
import { alarmBookAbi, approveTx, armTx, disarmAllTx, exitTx, planTx, registerTx, routerAbi, type Tx } from "./tx";

const vaultAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

const pausedAbi = parseAbi(["function paused() view returns (bool)"]);

const DUST = 10_000n; // $0.01 in 6-decimal stablecoins

export interface Position { vault: Vault; shares: bigint; assets: bigint }
/** A connected wallet, and a hook to tell the person what their wallet is waiting on. */
export interface Signer { provider: Eip1193; account: Address; onConfirm: () => void }
export interface PresetView { preset: Preset; status: AlarmStatus }

/** Whether a detector is one of the chosen presets, or a part one of them depends on. */
function needed(presets: Preset[], keys: Hex[], d: Detector): boolean {
  const key = keyOf(d);
  return presets.filter((p) => keys.includes(p.key)).some((p) => p.key === key || (p.requires ?? []).some((r) => r.key === key));
}

/** Every read and transaction for one network. Each network keeps its own client and its own risk cards. */
function make(c: Chain) {
  const client = createPublicClient({ transport: http(c.rpcUrl) });
  const live = autoExit(c);

  async function send(s: Signer, tx: Tx): Promise<Hex> {
    s.onConfirm();
    return sendTx(s.provider, client, s.account, tx, c);
  }

  async function position(v: Vault, owner: Address): Promise<Position | null> {
    const shares = await client.readContract({ address: v.address, abi: vaultAbi, functionName: "balanceOf", args: [owner] });
    if (shares === 0n) return null;
    const assets = await client.readContract({ address: v.address, abi: vaultAbi, functionName: "convertToAssets", args: [shares] });
    return assets < DUST ? null : { vault: v, shares, assets };
  }

  /** Reads every listed vault for one wallet. `failed` means the list may be missing positions. */
  async function scanWallet(owner: Address): Promise<{ found: Position[]; failed: boolean }> {
    let failed = false;
    const read = (v: Vault) => position(v, owner).catch(() => {
      failed = true;
      return null;
    });
    const found = (await Promise.all(c.vaults.map(read))).filter((x) => x !== null);
    return { found, failed };
  }

  /** Fetches every listed card once, so the API can't tell which vaults a wallet holds. With no API set, there are no cards. */
  let cards: Promise<Map<string, string | null>> | null = null;
  function riskCard(vault: Address) {
    if (!c.apiUrl) return Promise.resolve(null);
    cards ??= Promise.all(
      c.vaults.map(async (v) => {
        const r = await fetch(`${c.apiUrl}/risk/${v.address}`).catch(() => null);
        const body = r?.ok ? ((await r.json().catch(() => null)) as { text: string } | null) : null;
        return [v.address.toLowerCase(), body?.text ?? null] as const;
      }),
    ).then((list) => new Map(list));
    return cards.then((m) => m.get(vault.toLowerCase()) ?? null);
  }

  /** The router's id for an owner's vault position, and whether it is armed. Null when no contracts are set. */
  async function armState(owner: Address, vault: Address): Promise<{ posId: Hex; armed: boolean } | null> {
    if (!live) return null;
    const posId = await client.readContract({ address: c.router!, abi: routerAbi, functionName: "positionId", args: [owner, c.adapter!, vault, 0n] });
    const armed = await client.readContract({ address: c.router!, abi: routerAbi, functionName: "isArmed", args: [posId] });
    return { posId, armed };
  }

  /** AlarmBook reads for the going-off check. The time is the chain's, so a wrong browser clock can't hide a recent firing. */
  const alarmIo: AlarmIo = {
    check: (key) => client.readContract({ address: c.alarmBook!, abi: alarmBookAbi, functionName: "check", args: [key] }),
    firedAt: (key) => client.readContract({ address: c.alarmBook!, abi: alarmBookAbi, functionName: "state", args: [key] }).then((s) => BigInt(s[1])),
    now: () => client.getBlock().then((b) => b.timestamp),
    // The contract's own answer for every key of a preset, parts included, so a pending DRAIN confirmation blocks arming.
    armable: (key) => client.readContract({ address: c.alarmBook!, abi: alarmBookAbi, functionName: "armable", args: [key] }),
    known: (key) => client.readContract({ address: c.alarmBook!, abi: alarmBookAbi, functionName: "state", args: [key] }).then((s) => s[0]),
  };

  /** Whether a vault answers paused(). Many have no pause switch, so a Paused alarm could never fire there and is not offered. */
  const answersPaused = (vault: Address) => client.readContract({ address: vault, abi: pausedAbi, functionName: "paused" }).then(() => true, () => false);

  /** The presets this vault can use. Worked out here, not fetched, so a compromised server can't swap in different alarm keys. */
  async function presetViews(vault: Address): Promise<PresetView[]> {
    const paused = await answersPaused(vault);
    // An alarm that is going off now, or fired in the last day, would exit this position for something that happened before the owner arrived.
    return Promise.all(presetsFor(vault, vault, { paused }).map(async (preset): Promise<PresetView> => ({ preset, status: await presetStatus(alarmIo, preset) })));
  }

  /** A gate the curator gave up can still be locked on, so this reads what the gates would do to this exit. */
  function gatesBlock(vault: Address, owner: Address) {
    const read: Read = (address, functionName, args = []) => client.readContract({ address, abi: gateAbi, functionName, args } as never) as Promise<unknown>;
    return exitBlocked(read, vault, owner, c.adapter!, c.router!);
  }

  /** Registers any missing alarms, approves the shares if needed, then arms. Each step is its own wallet signature. */
  async function arm(s: Signer, vault: Address, keys: Hex[]) {
    const paused = await answersPaused(vault);
    const presets = presetsFor(vault, vault, { paused });
    // Read again at the moment of arming: the list on screen may be minutes old. Nothing is sent if any key is going off.
    if (keys.some((k) => !presets.some((p) => p.key === k)) || (await refusedPresets(alarmIo, presets, keys)).length > 0) throw new Error(COPY.armRefused);
    for (const d of registrationOrder(vault, vault, { paused }).filter((d) => needed(presets, keys, d))) {
      const known = await client.readContract({ address: c.alarmBook!, abi: alarmBookAbi, functionName: "state", args: [keyOf(d)] });
      if (!known[0]) await send(s, registerTx(c.alarmBook!, d));
    }
    const allowed = await client.readContract({ address: vault, abi: vaultAbi, functionName: "allowance", args: [s.account, c.router!] });
    if (allowed < maxUint256 / 2n) await send(s, approveTx(vault, c.router!));
    // The contract's own answer, now that every key is registered: the router asks it again inside arm and reverts if any key fails it.
    const armable = (key: Hex) => client.readContract({ address: c.alarmBook!, abi: alarmBookAbi, functionName: "armable", args: [key] });
    // The parts of a chosen preset are asked too: the router only asks about the keys it arms.
    const asked = [...new Set(presets.filter((p) => keys.includes(p.key)).flatMap((p) => [p.key, ...(p.requires ?? []).map((q) => q.key)]))];
    if ((await notArmable(armable, asked)).length > 0) throw new Error(COPY.armRefused);
    const tx = armTx(c.router!, c.adapter!, vault, keys);
    // Run it once without sending, so a refusal reads in plain words and not as a wallet's raw error.
    await client.call({ account: s.account, to: tx.to, data: tx.data }).catch((e) => {
      const known = revertText(e);
      if (known) throw new Error(known);
    });
    await send(s, tx);
  }

  /** Exit Now. The router only handles armed positions; anyone else withdraws from the vault as usual. Returns the exit's transaction. */
  async function exitNow(s: Signer, vault: Address, posId: Hex): Promise<{ hash: Hex; complete: boolean }> {
    const hash = await send(s, exitTx(c.router!, posId));
    const left = await client.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [s.account] });
    return { hash, complete: left === 0n };
  }

  const disarmAll = (s: Signer) => send(s, disarmAllTx(c.router!));

  /** A plan is paid in this network's plan token to this network's payments address, and covers only this network. */
  const payPlan = (s: Signer, amount: bigint) => send(s, planTx(c.planToken, c.planPayTo!, amount));

  return { chain: c, client, live, scanWallet, riskCard, armState, presetViews, gatesBlock, arm, exitNow, disarmAll, payPlan };
}

export type Net = ReturnType<typeof make>;

const nets = new Map<string, Net>();

/** The reads and transactions for one network, made once per network. */
export function network(c: Chain): Net {
  let n = nets.get(c.key);
  if (!n) nets.set(c.key, (n = make(c)));
  return n;
}
