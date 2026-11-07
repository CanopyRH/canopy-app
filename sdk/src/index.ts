import { lookThrough } from "../../services/src/risk/lookthrough";
import { explainExposure } from "../../services/src/copilot/explain";
import { createPublicClient, encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, http, isAddress, keccak256, parseAbi, zeroAddress, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { CHAINS, autoExit, type Chain } from "../../web/src/config";
import { TERMS } from "../../web/src/copy/text";
import { approveTx, armTx, exitTx, isBlocked, registerTx, termsHash, type Tx } from "../../web/src/tx";
import { presetStatus, type AlarmIo } from "../../web/src/alarms";
import { loadReceipt, receiptLink } from "../../web/src/receipt";
import { exitBlocked, gateAbi } from "../../web/src/gates";
import { keyOf, presetsFor, registrationOrder, type Preset } from "../../services/src/api/presets";
import { alarmBookAbi, routerAbi } from "../../services/src/chain/abi.generated";

export { CHAINS, TERMS };
export type { Chain };

const vaultAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function allowance(address,address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function curator() view returns (address)",
]);

export class CanopyError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "CanopyError"; }
}
const fail = (code: string, message: string): never => { throw new CanopyError(code, message); };
const address = (value: string): Address => {
  if (!isAddress(value, { strict: false }) || value.toLowerCase() === zeroAddress) return fail("bad_address", "Use a nonzero EVM address.");
  return getAddress(value.toLowerCase());
};
const hash = (value: string): Hex => /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() as Hex : fail("bad_hash", "Use a 32-byte hash.");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const positionId = (owner: Address, adapter: Address, target: Address) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [owner, adapter, target, 0n]));

type Snapshot = { blockNumber: bigint; timestamp: bigint };
type StoredPosition = readonly [Address, bigint, bigint, boolean, number, number, Address, Address, Address, boolean, bigint];
type SwapLeg = { token: Address; feed: Address; heartbeat: number; tokenDecimals: number; path: Hex };
export interface UnsignedStep extends Tx { chainId: number; from: Address; value: "0x0"; purpose: string }
export interface TransactionPlan {
  kind: "unsigned";
  action: "arm" | "tighten" | "exit";
  chainId: number;
  owner: Address;
  positionId: Hex;
  observedAt: Snapshot;
  requiresOwnerApproval: true;
  transactions: UnsignedStep[];
  notes: string[];
  terms?: { text: string; hash: Hex };
  previousKeys?: Hex[];
  keys?: Hex[];
  payout?: { harbour: number; maxSlipBps: number; swaps: readonly SwapLeg[] };
}

/** A local read/calldata client. It has no signer, wallet provider, private-key input or broadcast method. */
export function createCanopy(options: { chainId?: number; rpcUrl?: string; client?: PublicClient } = {}) {
  const chain = CHAINS.find((c) => c.chainId === (options.chainId ?? 4663));
  if (!chain || !autoExit(chain)) return fail("unsupported_chain", "This network has no configured live Canopy deployment.");
  const c = chain;
  const client = options.client ?? createPublicClient({ transport: http(options.rpcUrl ?? c.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  const router = c.router!, book = c.alarmBook!, adapter = c.adapter!;
  const read = <T>(at: Snapshot, contract: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: contract, abi, functionName, args, blockNumber: at.blockNumber } as never) as Promise<T>;
  async function snapshot(): Promise<Snapshot> {
    if (await client.getChainId() !== c.chainId) return fail("wrong_chain", "The RPC is connected to a different network.");
    const block = await client.getBlock();
    if (block.number === null) return fail("pending_block", "A mined block is required.");
    return { blockNumber: block.number, timestamp: block.timestamp };
  }
  function vaultAddress(value: string): Address {
    const v = address(value);
    if (!c.vaults.some((x) => same(x.address, v))) return fail("unsupported_vault", "This SDK currently supports the app's listed ERC-4626 vaults only.");
    return v;
  }
  function ownerAddress(value: string): Address {
    const owner = address(value);
    if (isBlocked(owner)) return fail("blocked_address", "This address is not supported by the app.");
    return owner;
  }
  const stored = (at: Snapshot, id: Hex) => read<StoredPosition>(at, router, routerAbi, "positions", [id]);
  const keysOf = (at: Snapshot, id: Hex) => read<readonly Hex[]>(at, router, routerAbi, "keysOf", [id]);
  function alarmIo(at: Snapshot): AlarmIo {
    const state = (key: Hex) => read<readonly [boolean, bigint, ...unknown[]]>(at, book, alarmBookAbi, "state", [key]);
    return {
      check: (key) => read<boolean>(at, book, alarmBookAbi, "check", [key]),
      firedAt: async (key) => (await state(key))[1],
      now: async () => at.timestamp,
      known: async (key) => (await state(key))[0],
      armable: (key) => read<boolean>(at, book, alarmBookAbi, "armable", [key]),
    };
  }
  async function alarms(at: Snapshot, vault: Address) {
    const paused = await read<boolean>(at, vault, vaultAbi, "paused").then(() => true, () => false);
    const presets = presetsFor(vault, vault, { paused });
    const io = alarmIo(at);
    return { paused, presets, views: await Promise.all(presets.map(async (preset) => ({ ...preset, status: await presetStatus(io, preset) }))) };
  }
  async function position(at: Snapshot, owner: Address, vault: Address) {
    const id = positionId(owner, adapter, vault);
    const [shares, asset, armed, keys] = await Promise.all([
      read<bigint>(at, vault, vaultAbi, "balanceOf", [owner]),
      read<Address>(at, vault, vaultAbi, "asset"),
      read<boolean>(at, router, routerAbi, "isArmed", [id]),
      keysOf(at, id),
    ]);
    const [assets, assetDecimals, maxRedeem] = await Promise.all([
      read<bigint>(at, vault, vaultAbi, "convertToAssets", [shares]),
      read<number>(at, asset, vaultAbi, "decimals"),
      read<bigint>(at, vault, vaultAbi, "maxRedeem", [owner]).catch(() => null),
    ]);
    return { vault, name: c.vaults.find((v) => same(v.address, vault))!.name, positionId: id, owner, shares, asset, assets, assetDecimals,
      assetAmount: formatUnits(assets, assetDecimals), armed, keys: [...keys], maxRedeem,
      liquidity: maxRedeem === null ? "unknown" : maxRedeem < shares ? "limited" : "available-at-read" };
  }
  async function checkWallet(ownerInput: string) {
    const owner = ownerAddress(ownerInput), at = await snapshot();
    const results = await Promise.all(c.vaults.map(async (v) => {
      try { return { ok: true as const, position: await position(at, owner, v.address) }; }
      catch { return { ok: false as const, vault: v.address, error: "read_failed" }; }
    }));
    return { chainId: c.chainId, owner, observedAt: at, coverage: "listed-erc4626-vaults-only",
      positions: results.flatMap((r) => r.ok && (r.position.shares > 0n || r.position.armed) ? [r.position] : []),
      failures: results.flatMap((r) => !r.ok ? [{ vault: r.vault, error: r.error }] : []), complete: results.every((r) => r.ok) };
  }
  async function listAlarms(vaultInput: string) {
    const vault = vaultAddress(vaultInput), at = await snapshot();
    return { chainId: c.chainId, vault, observedAt: at, alarms: (await alarms(at, vault)).views };
  }
  async function explainPosition(ownerInput: string, vaultInput: string) {
    const owner = ownerAddress(ownerInput), vault = vaultAddress(vaultInput), at = await snapshot();
    const [p, a, curator, vaultOwner, exposure] = await Promise.all([
      position(at, owner, vault), alarms(at, vault),
      read<Address>(at, vault, vaultAbi, "curator").catch(() => null),
      read<Address>(at, vault, vaultAbi, "owner").catch(() => null),
      lookThrough(client,vault,at.blockNumber),
    ]);
    return { chainId: c.chainId, observedAt: at, position: p, curator, vaultOwner, exposure,
      explanation: [
        `This wallet holds ${p.shares} raw shares in ${p.name}, worth ${p.assetAmount} units of asset ${p.asset} at this block.`,
        p.armed ? `The position is armed with ${p.keys.length} alarm keys.` : "Automatic exits are not armed for this position.",
        p.liquidity === "unknown" ? "Current withdrawable liquidity could not be read." : p.liquidity === "limited" ? "The vault reports that fewer than all of these shares can be redeemed now." : "The vault reports these shares as redeemable at this block; execution can still fail or become partial.",
        "Every Canopy payout goes to the position owner. Keeper availability and plan coverage are not checked here.",
        ...explainExposure(exposure),
      ],
      alarmOptions: a.views,
      unknown: ["Allocations beyond the bounded exposure view", "Oracle configuration and trading sessions", "External ratings", "Whether these alarms are suitable for the owner"],
      sources: [{ kind: "rpc", chainId: c.chainId, blockNumber: at.blockNumber, contract: vault }, { kind: "rpc", chainId: c.chainId, blockNumber: at.blockNumber, contract: router }] };
  }
  function plan(action: TransactionPlan["action"], owner: Address, id: Hex, at: Snapshot, steps: { tx: Tx; purpose: string }[]): TransactionPlan {
    return { kind: "unsigned", action, chainId: c.chainId, owner, positionId: id, observedAt: at, requiresOwnerApproval: true,
      transactions: steps.map(({ tx, purpose }) => ({ ...tx, from: owner, chainId: c.chainId, value: "0x0", purpose })),
      notes: ["Nothing has been signed or sent. Review each transaction in the owner's wallet.",
        "State can change after this read. Rebuild and simulate before signing; wait for each transaction before the next.",
        "This is an owner-approved proposal, not an enforced session-key policy. Do not grant an agent unrestricted wallet access."] };
  }
  async function prepare(ownerInput: string, vaultInput: string, keysInput: readonly string[], tighten: boolean): Promise<TransactionPlan> {
    const owner = ownerAddress(ownerInput), vault = vaultAddress(vaultInput);
    if (!keysInput.length || keysInput.length > 8) return fail("bad_keys", "Choose between one and eight alarm keys.");
    const chosen = keysInput.map(hash);
    if (new Set(chosen).size !== chosen.length) return fail("duplicate_keys", "Choose each alarm only once.");
    const at = await snapshot(), id = positionId(owner, adapter, vault);
    const [p, active, oldKeys, allowed, paused, expiry, a] = await Promise.all([
      stored(at, id), read<boolean>(at, router, routerAbi, "isArmed", [id]), keysOf(at, id),
      read<boolean>(at, router, routerAbi, "adapterAllowed", [adapter]), read<boolean>(at, router, routerAbi, "armingPaused"),
      read<bigint>(at, router, routerAbi, "ADMIN_EXPIRY"), alarms(at, vault),
    ]);
    if (!allowed || (paused && at.timestamp < expiry)) return fail("arming_unavailable", "New arming is unavailable at this block.");
    if (await exitBlocked((contract, name, args = []) => read(at, contract, gateAbi, name, args), vault, owner, adapter, router)) {
      return fail("withdrawal_gate", "This vault's withdrawal gates would block a Canopy exit.");
    }
    if (tighten && (!active || !same(p[0], owner) || !same(p[6], adapter) || !same(p[7], vault) || p[9] || p[10] !== 0n)) return fail("not_armed", "Tighten needs an armed position in this vault owned by this wallet.");
    if (!tighten && active) return fail("already_armed", "Use tighten to add alarms without replacing existing settings.");
    const selected: Preset[] = [];
    for (const key of chosen) {
      const v = a.views.find((x) => same(x.key, key));
      if (!v) return fail("unsupported_alarm", "Choose keys from list_alarms for this vault.");
      if (v.status !== "clear") return fail("alarm_not_clear", "A chosen alarm is going off or cannot be read. Use exit_now if you want to leave.");
      selected.push(v);
    }
    const previous = tighten ? [...oldKeys].map((k) => k.toLowerCase() as Hex) : [];
    const keys = [...new Set([...previous, ...chosen])];
    if (keys.length > 8) return fail("too_many_keys", "The existing and added alarms exceed the router's eight-key limit.");
    if (tighten && keys.length === previous.length) return fail("no_change", "These alarms are already armed.");
    if (tighten) for (const key of previous) {
      if (!(await read<boolean>(at, book, alarmBookAbi, "armable", [key]))) return fail("alarm_not_clear", "An existing alarm is going off or cannot be rearmed. Use exit_now instead.");
    }
    const wanted = new Set(selected.flatMap((v) => [v.key, ...(v.requires ?? []).map((r) => r.key)]));
    const steps: { tx: Tx; purpose: string }[] = [];
    for (const detector of registrationOrder(vault, vault, { paused: a.paused }).filter((d) => wanted.has(keyOf(d)))) {
      if (!(await alarmIo(at).known!(keyOf(detector)))) steps.push({ tx: registerTx(book, detector), purpose: `Register alarm ${keyOf(detector)}` });
    }
    const [shares, allowance] = await Promise.all([
      read<bigint>(at, vault, vaultAbi, "balanceOf", [owner]), read<bigint>(at, vault, vaultAbi, "allowance", [owner, router]),
    ]);
    if (shares === 0n) return fail("empty_position", "This wallet has no shares in this vault.");
    if (allowance < shares) steps.push({ tx: approveTx(vault, router), purpose: "Approve unlimited vault shares to the Canopy router, as in the app" });
    let tx: Tx;
    let payout: NonNullable<TransactionPlan["payout"]> = { harbour: 0, maxSlipBps: 0, swaps: [] };
    if (tighten) {
      const swaps = await read<readonly SwapLeg[]>(at, router, routerAbi, "swapsOf", [id]);
      payout = { harbour: p[4], maxSlipBps: p[5], swaps };
      // Keep every payout setting byte-for-byte. The agent can only propose additional preset keys.
      tx = { to: router, data: encodeFunctionData({ abi: routerAbi, functionName: "arm", args: [{ adapter: p[6], target: p[7], tokenId: p[10], harbour: p[4], maxSlipBps: p[5], termsHash: termsHash(), keys, swaps }] }) };
    } else tx = armTx(router, adapter, vault, keys);
    steps.push({ tx, purpose: tighten ? "Add alarms, preserving all existing alarms and payout settings" : "Arm the selected alarms; pay the vault's raw asset to the owner" });
    const out = plan(tighten ? "tighten" : "arm", owner, id, at, steps);
    return { ...out, previousKeys: previous, keys, payout, terms: { text: TERMS, hash: termsHash() }, notes: [...out.notes,
      "Arming records acceptance of these terms. The owner must review and accept them before signing.",
      "Rearming resets the arming time. This proposal preserves the settings observed at the stated block; an on-chain policy is still needed to enforce a floor against concurrent changes."] };
  }
  async function exitNow(ownerInput: string, vaultInput: string): Promise<TransactionPlan> {
    const owner = ownerAddress(ownerInput), vault = vaultAddress(vaultInput), at = await snapshot(), id = positionId(owner, adapter, vault);
    const p = await stored(at, id);
    if (!same(p[0], owner) || !same(p[6], adapter) || !same(p[7], vault)) return fail("unknown_position", "This wallet has no recorded Canopy position in this vault. Withdraw directly from the vault instead.");
    // The owner may exit a previously armed position even after disarming. No payment or live alarm is required.
    const tx = exitTx(router, id);
    await client.call({ account: owner, to: tx.to, data: tx.data, blockNumber: at.blockNumber }).catch(() => fail("exit_simulation_failed", "This exit could not be simulated. Check shares, allowance and withdrawal liquidity in the app."));
    return plan("exit", owner, id, at, [{ tx, purpose: "Exit available shares to the position owner; a partial exit may leave shares behind" }]);
  }
  async function exitReceipt(hashInput: string) {
    const txHash = hash(hashInput);
    await snapshot();
    return { receipt: await loadReceipt(txHash, c, client), link: receiptLink(c, txHash) };
  }
  return { chain: c, checkWallet, explainPosition, listAlarms, armPosition: (owner: string, vault: string, keys: readonly string[]) => prepare(owner, vault, keys, false),
    tighten: (owner: string, vault: string, keys: readonly string[]) => prepare(owner, vault, keys, true), exitNow, exitReceipt };
}

export type Canopy = ReturnType<typeof createCanopy>;
/** RPC-sized integers are decimal strings at the MCP/JSON boundary, never rounded JavaScript numbers. */
export const toJson = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v);
export { createObservatory, sessionIcs, heartbeatTyped, type Observatory } from "./research";
