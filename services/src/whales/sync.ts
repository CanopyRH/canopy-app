import { decodeEventLog, getAbiItem, toEventSelector, type Address, type PublicClient } from "viem";
import { erc20Abi, vaultAbi } from "../chain/abi";
import { txUrl } from "../chain/addresses";
import { whaleAlert, WHALE_TOPIC, shortWallet } from "../copy/whales";
import { syncLogs, type Log, type ReorgInfo } from "../indexer/indexer";
import type { StuckLog } from "../indexer/retry";
import type { Repo } from "../store/repo";
import type { Db } from "../store/db";
import { DOLLAR_ASSETS, MAX_ALERT_AGE_SEC, type WhaleConfig } from "./config";
import { sizeMove, usdCentsOf, whaleEvents, type Direction } from "./detect";
import { whaleStore } from "./store";

const lc = (a: string) => a.toLowerCase();
const DEPOSIT = toEventSelector(getAbiItem({ abi: whaleEvents, name: "Deposit" }));
const WITHDRAW = toEventSelector(getAbiItem({ abi: whaleEvents, name: "Withdraw" }));

/** The reader's own cursor. Named for the chain, so it can never be confused with the router's or the alarms'. */
export const whaleCursor = (chainId: number) => `whales:${chainId}`;

export interface WhaleDeps {
  client: Pick<PublicClient, "getBlockNumber" | "getLogs" | "readContract"> & Partial<Pick<PublicClient, "getBlock">>;
  repo: Repo;
  db: Db;
  chainId: number;
  now: () => number;
  /** The listed vaults, lowercase. */
  listed: string[];
  confirmations: bigint;
  cfg: WhaleConfig;
  /** Queues a follower alert under a topic (see bot/queue.ts). */
  queueAlert: (vault: string, text: string, tag: string, topic: string) => Promise<unknown>;
  fence?: () => Promise<void>;
  onStuck?: (s: StuckLog) => Promise<unknown>;
  onDeepReorg?: (i: ReorgInfo) => Promise<unknown>;
  /** Blocks of hashes to remember; tests shrink it. */
  window?: bigint;
}

interface AssetInfo { asset: Address; decimals: number; symbol: string }

/** Reads ERC-4626 deposits and withdrawals on the listed vaults and tells followers about the big ones. */
export function whaleReader(d: WhaleDeps) {
  const store = whaleStore(d.db);
  /** A vault's asset, or null for one with no dollar price. A failed read is not remembered. */
  const assets = new Map<string, AssetInfo | null>();

  async function assetOf(vault: Address): Promise<AssetInfo | null> {
    const known = assets.get(vault);
    if (known !== undefined) return known;
    const asset = (await d.client.readContract({ address: vault, abi: vaultAbi, functionName: "asset" })) as Address;
    const [decimals, symbol] = await Promise.all([
      d.client.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }),
      d.client.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }),
    ]);
    const info = DOLLAR_ASSETS.includes(String(symbol).toUpperCase()) ? { asset, decimals: Number(decimals), symbol: String(symbol) } : null;
    if (!info) console.warn("whales: skipping a vault whose asset has no dollar price", vault, String(symbol));
    assets.set(vault, info);
    return info;
  }

  const nameOf = async (vault: string) => ((await d.repo.card(vault)) as { numbers?: { name?: string } } | null)?.numbers?.name ?? shortWallet(vault);

  /** Applies one log. Safe to replay: the row is written once, and the alert is queued once. */
  async function apply(l: Log) {
    const topic = l.topics[0];
    if (topic !== DEPOSIT && topic !== WITHDRAW) return;
    const vault = lc(l.address);
    if (!d.listed.includes(vault) || l.blockNumber == null || !l.transactionHash || l.logIndex == null) return;
    const info = await assetOf(vault as Address);
    if (!info) return;
    const ev = decodeEventLog({ abi: whaleEvents, data: l.data, topics: l.topics as never });
    const a = ev.args as unknown as { assets: bigint; owner: Address };
    const dir: Direction = ev.eventName === "Withdraw" ? "out" : "in";
    const totalAfter = (await d.client.readContract({ address: vault as Address, abi: vaultAbi, functionName: "totalAssets", blockNumber: l.blockNumber })) as bigint;
    const size = sizeMove(d.cfg, { dir, assets: a.assets, totalAfter, decimals: info.decimals });
    if (!size.whale) return;
    if (!d.client.getBlock) throw new Error("the client cannot read block times");
    const at = Number((await d.client.getBlock({ blockNumber: l.blockNumber })).timestamp);
    // What sits idle in the vault now. A failed read leaves it out of the alert; it never stops the alert.
    const liquid = await Promise.resolve(d.client.readContract({ address: info.asset, abi: erc20Abi, functionName: "balanceOf", args: [vault as Address] }))
      .then((v) => usdCentsOf(v as bigint, info.decimals), () => null);
    const row = await store.record({
      tx: l.transactionHash, logIndex: l.logIndex, block: l.blockNumber, at, vault, dir, whale: lc(a.owner), assets: a.assets, decimals: info.decimals,
      symbol: info.symbol, usdCents: size.usdCents, pctBps: size.pctBps, liquidCents: liquid,
    });
    if (row.alerted) return;
    const now = d.now();
    // Old moves (a reader catching up) and a vault already busy this hour are recorded, not announced.
    if (now - row.at > MAX_ALERT_AGE_SEC || (await store.alertedSince(vault, now - 3_600)) >= d.cfg.maxPerHour) return;
    const text = whaleAlert({
      dir: row.dir, vaultName: await nameOf(vault), usdCents: row.usdCents, pctBps: row.pctBps, liquidCents: row.liquidCents, wallet: row.whale,
      tx: row.tx, txUrl: txUrl(d.chainId, row.tx), at: row.at,
    });
    await d.queueAlert(vault, text, `whale:${row.tx}:${row.logIndex}`, WHALE_TOPIC);
    await store.markAlerted(row.tx, row.logIndex);
  }

  /** One pass: reads what is new, undoing and re-reading across a reorg. */
  async function sync() {
    const name = whaleCursor(d.chainId);
    if (d.listed.length === 0) return;
    // A first run starts at the head, so history isn't announced as news. The cursor is saved at once, or the head would keep moving.
    if ((await d.repo.cursor(name)) === null) await d.repo.setCursor(name, d.cfg.startBlock ?? (await d.client.getBlockNumber()));
    return syncLogs(d.client, d.repo, {
      name, now: d.now, fence: d.fence, address: d.listed as Address[], startBlock: d.cfg.startBlock ?? 0n, confirmations: d.confirmations, window: d.window,
      onLog: apply, onRewind: (from) => store.undoFrom(from), onStuck: d.onStuck, onDeepReorg: d.onDeepReorg,
    });
  }

  return { sync, apply, store };
}
