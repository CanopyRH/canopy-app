// Whale alerts: which moves count, the reader's reorg and replay safety, what followers are sent, /whales, and GET /whales.
// Runs on real Postgres when TEST_DATABASE_URL is set.
import { beforeEach, describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { createApi } from "../src/api/server";
import { handle } from "../src/bot/bot";
import { notifyText } from "../src/bot/bot";
import { queueAlert, sendQueuedAlerts } from "../src/bot/queue";
import { findBanned } from "../../tools/banned-words";
import { pctText, shortWallet, usdShort, whaleAlert } from "../src/copy/whales";
import type { Log } from "../src/indexer/indexer";
import { PLUGINS } from "../src/plugins";
import type { Db } from "../src/store/db";
import { repo, type Repo } from "../src/store/repo";
import { whaleConfig, type WhaleConfig } from "../src/whales/config";
import { sizeMove, whaleEvents } from "../src/whales/detect";
import { whaleCursor, whaleReader } from "../src/whales/sync";
import { freshDb } from "./db";

const VAULT = "0x00000000000000000000000000000000000000c3" as Address;
const OTHER_VAULT = "0x00000000000000000000000000000000000000c4" as Address;
const ASSET = "0x00000000000000000000000000000000000000a5" as Address;
const WHALE = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const SENDER = "0x00000000000000000000000000000000000000d9" as Address;
const NOW = 2_000_000_000;
const USD = 1_000_000n; // the asset has 6 decimals
const tx = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}` as Hex;
const CFG: WhaleConfig = { watch: true, minUsd: 250_000, minPct: 2, maxPerHour: 6, startBlock: 1n };

let db: Db;
let r: Repo;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

/** A chain with one listed vault. totalAssets and the idle balance are what the vault holds after every move. */
class Chain {
  forks = [{ from: 0n, tag: 1 }];
  logs: Log[] = [];
  head = 100n;
  total = 10_000_000n * USD;
  idle = 3_000_000n * USD;
  symbol = "USDG";
  times = new Map<bigint, number>();
  hash(n: bigint): Hex {
    const tag = [...this.forks].reverse().find((f) => f.from <= n)!.tag;
    return `0x${(BigInt(tag) * 1_000_000n + n).toString(16).padStart(64, "0")}`;
  }
  reorg(from: bigint, head: bigint, logs: Log[] = []) {
    this.forks.push({ from, tag: this.forks.length + 1 });
    this.head = head;
    this.logs = [...this.logs.filter((l) => l.blockNumber! < from), ...logs];
  }
  client = {
    getBlockNumber: async () => this.head,
    getBlock: async (o: { blockNumber: bigint }) => {
      if (o.blockNumber > this.head) throw Object.assign(new Error("Block not found."), { name: "BlockNotFoundError" });
      return { hash: this.hash(o.blockNumber), timestamp: BigInt(this.times.get(o.blockNumber) ?? NOW) };
    },
    getLogs: async (o: { address: Address | Address[]; fromBlock: bigint; toBlock: bigint }) => {
      const addrs = ([] as Address[]).concat(o.address).map((a) => a.toLowerCase());
      return this.logs
        .filter((l) => addrs.includes(l.address.toLowerCase()) && l.blockNumber! >= o.fromBlock && l.blockNumber! <= o.toBlock)
        .map((l) => ({ ...l, blockHash: this.hash(l.blockNumber!) }));
    },
    readContract: async (o: { address: Address; functionName: string }) => {
      switch (o.functionName) {
        case "asset": return ASSET;
        case "decimals": return 6;
        case "symbol": return this.symbol;
        case "totalAssets": return this.total;
        case "balanceOf": return this.idle;
      }
      throw new Error(`unexpected read ${o.functionName}`);
    },
  } as never;
}

function move(kind: "Deposit" | "Withdraw", usd: bigint, block: bigint, id: number, vault: Address = VAULT, logIndex = 0): Log {
  const assets = usd * USD;
  const args = kind === "Deposit" ? { sender: SENDER, owner: WHALE } : { sender: SENDER, receiver: WHALE, owner: WHALE };
  const abiItem = whaleEvents.find((x) => x.name === kind)!;
  const topics = encodeEventTopics({ abi: [abiItem], eventName: kind, args } as never);
  const data = encodeAbiParameters((abiItem.inputs as readonly { indexed?: boolean }[]).filter((i) => !i.indexed) as never, [assets, assets] as never);
  return { address: vault, data, topics: topics as never, blockNumber: block, transactionHash: tx(id), logIndex, blockHash: null };
}

const queued: { vault: string; text: string; tag: string; topic: string }[] = [];
function reader(chain: Chain, cfg: WhaleConfig = CFG, now = () => NOW) {
  queued.length = 0;
  return whaleReader({
    client: chain.client, repo: r, db, chainId: 4663, now, listed: [VAULT], confirmations: 0n, cfg,
    queueAlert: async (vault, text, tag, topic) => {
      queued.push({ vault, text, tag, topic });
      await queueAlert(r, vault, text, now(), tag, topic);
    },
  });
}
const rows = () => db.query<{ tx: string; block: string; alerted: boolean }>(`SELECT tx, block::text AS block, alerted FROM whale_moves ORDER BY whale_moves.block, log_index`);

describe("what counts as a whale move", () => {
  const dec = 6;
  const size = (usd: bigint, totalUsd: bigint, dir: "in" | "out" = "in", cfg = { minUsd: 250_000, minPct: 2 }) =>
    sizeMove(cfg, { dir, assets: usd * USD, totalAfter: totalUsd * USD, decimals: dec });

  test("the dollar floor is the bar on a small vault", () => {
    // 2% of a $5M vault is $100K, so $250K is the bar.
    expect(size(249_999n, 5_000_000n).whale).toBe(false);
    expect(size(250_000n, 5_000_000n).whale).toBe(true);
    expect(size(250_000n, 5_000_000n).barCents).toBe(25_000_000n);
  });

  test("the percent is the bar on a big vault", () => {
    // 2% of $100M is $2M.
    expect(size(1_999_999n, 100_000_000n).whale).toBe(false);
    expect(size(2_000_000n, 100_000_000n).whale).toBe(true);
    expect(size(2_000_000n, 100_000_000n).barCents).toBe(200_000_000n);
  });

  test("a move one cent under the bar is quiet, and a zero move never counts", () => {
    const c = sizeMove({ minUsd: 250_000, minPct: 2 }, { dir: "in", assets: 249_999_990_000n, totalAfter: 5_000_000n * USD, decimals: dec });
    expect(c.whale).toBe(false);
    expect(sizeMove({ minUsd: 0, minPct: 0 }, { dir: "in", assets: 0n, totalAfter: 1n, decimals: dec }).whale).toBe(false);
  });

  test("a withdrawal is measured against the vault before it left", () => {
    // $1M leaves a vault that holds $9M afterwards: it was a $10M vault, so 10%.
    expect(size(1_000_000n, 9_000_000n, "out").pctBps).toBe(1_000);
    // $1M comes in and the vault holds $10M with it: also 10%.
    expect(size(1_000_000n, 10_000_000n, "in").pctBps).toBe(1_000);
    expect(size(1_000_000n, 0n, "out").pctBps).toBe(10_000); // emptied it
    expect(size(1_000_000n, 1_000_000n, "in").pctBps).toBe(10_000);
  });

  test("decimals come from the asset, not a fixed 6", () => {
    const eighteen = sizeMove({ minUsd: 250_000, minPct: 2 }, { dir: "in", assets: 300_000n * 10n ** 18n, totalAfter: 5_000_000n * 10n ** 18n, decimals: 18 });
    expect(eighteen.usdCents).toBe(30_000_000n);
    expect(eighteen.whale).toBe(true);
  });

  test("the bar can be configured, and defaults to $250,000 and 2%", () => {
    expect(whaleConfig({})).toEqual({ watch: true, minUsd: 250_000, minPct: 2, maxPerHour: 6, startBlock: undefined });
    const c = whaleConfig({ WHALE_MIN_USD: "1000000", WHALE_MIN_PCT: "0.5", WHALE_MAX_PER_HOUR: "", WHALE_WATCH: "false", WHALE_START_BLOCK: "77" });
    expect(c).toEqual({ watch: false, minUsd: 1_000_000, minPct: 0.5, maxPerHour: 6, startBlock: 77n });
    expect(size(150_000n, 5_000_000n, "in", { minUsd: 100_000, minPct: 2 }).whale).toBe(true);
  });
});

describe("the reader", () => {
  test("a big withdrawal is recorded and queued for the vault's followers under the whales topic", async () => {
    const chain = new Chain();
    chain.logs = [move("Withdraw", 1_200_000n, 50n, 1)];
    const w = reader(chain);
    await w.sync();
    expect(await rows()).toEqual([{ tx: tx(1), block: "50", alerted: true }]);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.topic).toBe("whales");
    expect(queued[0]!.vault).toBe(VAULT);
    expect(queued[0]!.text).toContain("$1.2M just left");
    expect(queued[0]!.text).toContain("(10.7% of the vault)"); // 1.2M of the 11.2M it held before
    expect(queued[0]!.text).toContain("Liquid now: $3M");
    expect(queued[0]!.text).toContain(`https://robinhoodchain.blockscout.com/tx/${tx(1)}`);
    expect((await db.query(`SELECT 1 FROM jobs WHERE kind='alert'`)).length).toBe(1);
  });

  test("a deposit reads as money moving in", async () => {
    const chain = new Chain();
    chain.logs = [move("Deposit", 600_000n, 50n, 2)];
    await reader(chain).sync();
    expect(queued[0]!.text).toContain("$600K just moved into");
  });

  test("small moves, other events, other vaults and assets with no dollar price are ignored", async () => {
    const chain = new Chain();
    const transfer: Log = { ...move("Deposit", 900_000n, 51n, 5), topics: [`0x${"dd".repeat(32)}`] as never };
    chain.logs = [move("Withdraw", 100_000n, 50n, 3), transfer, move("Withdraw", 900_000n, 52n, 4, OTHER_VAULT)];
    await reader(chain).sync();
    expect(await rows()).toEqual([]);
    const weth = new Chain();
    weth.symbol = "WETH";
    weth.logs = [move("Withdraw", 900_000n, 50n, 6)];
    await reader(weth).sync();
    expect(await rows()).toEqual([]);
  });

  test("the bar follows the config: the same move is quiet at a higher bar", async () => {
    const chain = new Chain();
    chain.logs = [move("Withdraw", 400_000n, 50n, 7)];
    await reader(chain, { ...CFG, minUsd: 500_000 }).sync();
    expect(await rows()).toEqual([]);
  });

  test("a log read twice, or replayed, is one row and one alert", async () => {
    const chain = new Chain();
    const log = move("Withdraw", 1_000_000n, 50n, 8);
    chain.logs = [log];
    const w = reader(chain);
    await w.sync();
    await w.sync();
    await w.apply({ ...log, blockHash: chain.hash(50n) });
    await w.apply({ ...log, blockHash: chain.hash(50n) });
    expect((await rows()).length).toBe(1);
    expect(queued).toHaveLength(1);
    expect((await db.query(`SELECT 1 FROM jobs WHERE kind='alert'`)).length).toBe(1);
  });

  test("a replay after the alert text could differ still sends once", async () => {
    const chain = new Chain();
    const log = move("Withdraw", 1_000_000n, 50n, 9);
    chain.logs = [log];
    const w = reader(chain);
    await w.apply(log);
    chain.idle = 1n * USD; // the vault's idle balance moved on
    await w.apply(log);
    expect((await db.query(`SELECT 1 FROM jobs WHERE kind='alert'`)).length).toBe(1);
  });

  test("the first run starts at the head, so history is not announced", async () => {
    const chain = new Chain();
    chain.logs = [move("Withdraw", 5_000_000n, 50n, 10)];
    await reader(chain, { ...CFG, startBlock: undefined }).sync();
    expect(await rows()).toEqual([]);
    expect(await r.cursor(whaleCursor(4663))).toBe(101n);
    // The cursor has its own name, apart from the router's and the alarms'.
    expect(whaleCursor(4663)).toBe("whales:4663");
  });

  test("a reorg that drops the move removes its row, and one that moves it re-writes it", async () => {
    const chain = new Chain();
    chain.logs = [move("Withdraw", 1_000_000n, 90n, 11)];
    const w = reader(chain);
    await w.sync();
    expect((await rows()).map((x) => x.block)).toEqual(["90"]);
    // Blocks from 85 on are replaced and the move is not in them.
    chain.reorg(85n, 110n);
    await w.sync();
    expect(await rows()).toEqual([]);
    // It lands again in a later block of the new fork.
    chain.reorg(105n, 120n, [move("Withdraw", 1_000_000n, 112n, 11)]);
    await w.sync();
    expect((await rows()).map((x) => x.block)).toEqual(["112"]);
  });

  test("a move reorged back into a new block is announced once, not twice", async () => {
    const chain = new Chain();
    chain.logs = [move("Withdraw", 1_000_000n, 90n, 12)];
    const w = reader(chain);
    await w.sync();
    chain.reorg(85n, 110n, [move("Withdraw", 1_000_000n, 95n, 12)]);
    await w.sync();
    expect((await rows()).map((x) => x.block)).toEqual(["95"]);
    // The first alert already went out; the re-read has the same words, so the queue holds one.
    expect((await db.query(`SELECT 1 FROM jobs WHERE kind='alert'`)).length).toBe(1);
  });

  test("the move's own time is used, and old moves are recorded but not announced", async () => {
    const chain = new Chain();
    chain.times.set(50n, NOW - 2 * 3_600);
    chain.logs = [move("Withdraw", 1_000_000n, 50n, 13)];
    await reader(chain).sync();
    expect(await rows()).toEqual([{ tx: tx(13), block: "50", alerted: false }]);
    expect(queued).toEqual([]);
  });

  test("a vault is announced at most WHALE_MAX_PER_HOUR times an hour; the rest are recorded", async () => {
    const chain = new Chain();
    chain.logs = [1, 2, 3].map((i) => move("Withdraw", 1_000_000n, BigInt(50 + i), 20 + i));
    await reader(chain, { ...CFG, maxPerHour: 2 }).sync();
    expect((await rows()).map((x) => x.alerted)).toEqual([true, true, false]);
    expect(queued).toHaveLength(2);
    // None at all when it is 0.
    const quiet = new Chain();
    quiet.logs = [move("Withdraw", 1_000_000n, 50n, 30)];
    await db.exec("DELETE FROM whale_moves");
    await r.setCursor(whaleCursor(4663), 1n);
    await reader(quiet, { ...CFG, maxPerHour: 0 }).sync();
    expect(queued).toEqual([]);
  });

  test("a failed totalAssets read parks the log and a later pass finishes it", async () => {
    const chain = new Chain();
    chain.logs = [move("Withdraw", 1_000_000n, 50n, 40)];
    const read = (chain.client as unknown as { readContract: (o: never) => unknown }).readContract;
    let down = true;
    (chain.client as { readContract: unknown }).readContract = async (o: { functionName: string }) => {
      if (down && o.functionName === "totalAssets") throw new Error("rpc down");
      return read(o as never);
    };
    let t = NOW;
    const w = reader(chain, CFG, () => t);
    await w.sync();
    expect(await rows()).toEqual([]);
    down = false;
    t += 600;
    await w.sync();
    expect(await rows()).toHaveLength(1);
  });
});

describe("followers", () => {
  const CHAT_A = 101, CHAT_B = 102, CHAT_C = 103;
  async function follow() {
    for (const c of [CHAT_A, CHAT_B]) await r.follow(c, VAULT);
    await r.follow(CHAT_C, OTHER_VAULT);
  }

  test("only chats following the vault hear it, and a chat that turned whales off does not", async () => {
    await follow();
    const chain = new Chain();
    chain.logs = [move("Withdraw", 1_000_000n, 50n, 50)];
    await reader(chain).sync();
    await handle(r, "https://app.example", CHAT_B, "whales", "off", [VAULT], db);
    const sent: number[] = [];
    await sendQueuedAlerts(r, (vault, text, topic) => notifyText(r, async (chat) => void sent.push(chat), vault, text, topic), () => NOW);
    expect(sent).toEqual([CHAT_A]);
    // Turning it back on is for the next alert.
    await handle(r, "https://app.example", CHAT_B, "whales", "on", [VAULT], db);
    expect(await r.followers(VAULT, "whales")).toEqual([CHAT_A, CHAT_B]);
  });

  test("muting whales does not mute an alarm alert", async () => {
    await follow();
    await handle(r, "https://app.example", CHAT_A, "whales", "off", [], db);
    expect(await r.followers(VAULT)).toEqual([CHAT_A, CHAT_B]);
  });
});

describe("the alert text", () => {
  const base = { dir: "out" as const, vaultName: "Steakhouse USDG", usdCents: 120_000_000n, pctBps: 410, liquidCents: 340_000_000n, wallet: WHALE, tx: tx(1), txUrl: `https://robinhoodchain.blockscout.com/tx/${tx(1)}`, at: NOW };

  test("it shows the vault, the amount, the share of the vault, the direction, the liquidity and the transaction", () => {
    const text = whaleAlert(base);
    expect(text.split("\n")[0]).toBe("🐋 $1.2M just left Steakhouse USDG (4.1% of the vault).");
    expect(text).toContain("Liquid now: $3.4M sitting idle in the vault.");
    expect(text).toContain(`Tx: https://robinhoodchain.blockscout.com/tx/${tx(1)}`);
    expect(text).toContain("Your alarms: arm one in the app");
    expect(whaleAlert({ ...base, dir: "in" })).toContain("just moved into Steakhouse USDG");
    expect(whaleAlert({ ...base, liquidCents: null })).toContain("Liquid now: unknown.");
  });

  test("the whale's full address never appears, only a short form", () => {
    const text = whaleAlert(base);
    expect(text).not.toContain(WHALE);
    expect(text.toLowerCase()).not.toContain(WHALE.toLowerCase().slice(6, 30));
    expect(text).toContain("0x1234…5678");
    expect(shortWallet("nonsense")).toBe("unknown");
  });

  test("amounts and percents read the way a person says them", () => {
    expect(usdShort(25_000_000n)).toBe("$250K");
    expect(usdShort(99_999_996n)).toBe("$1M"); // 999,999.96 rounds up a unit, never "$1000K"
    expect(usdShort(1_250_000_000n)).toBe("$12.5M");
    expect(usdShort(250_000_000_000n)).toBe("$2.5B");
    expect(usdShort(99_900n)).toBe("$999");
    expect(pctText(410)).toBe("4.1%");
    expect(pctText(5)).toBe("<0.1%");
    expect(pctText(10_000)).toBe("100%");
  });

  test("the copy passes the banned-words gate", () => {
    const all = [whaleAlert(base), whaleAlert({ ...base, dir: "in" })].join("\n");
    expect(findBanned(all)).toEqual([]);
  });
});

describe("/whales", () => {
  async function seed() {
    const chain = new Chain();
    chain.logs = [move("Withdraw", 1_200_000n, 50n, 60), move("Deposit", 400_000n, 51n, 61)];
    await reader(chain).sync();
    await r.saveCard(VAULT, { name: "Steakhouse USDG" } as never, "card", NOW);
  }

  test("lists the latest moves, newest first, with short wallets and a mute hint", async () => {
    await seed();
    const reply = await handle(r, "https://app.example", 7, "whales", "", [VAULT], db);
    const lines = reply.text.split("\n");
    expect(lines[0]).toContain("The last 2 whale moves");
    expect(lines[1]).toContain("In $400K to Steakhouse USDG");
    expect(lines[2]).toContain("Out $1.2M from Steakhouse USDG");
    expect(reply.text).toContain("0x1234…5678");
    expect(reply.text).not.toContain(WHALE);
    expect(lines.at(-1)).toContain("/whales off mutes them");
  });

  test("caps the list at 10", async () => {
    const chain = new Chain();
    chain.logs = Array.from({ length: 14 }, (_, i) => move("Withdraw", 1_000_000n, BigInt(40 + i), 70 + i));
    await reader(chain, { ...CFG, maxPerHour: 99 }).sync();
    const reply = await handle(r, "https://app.example", 7, "whales", "", [VAULT], db);
    expect(reply.text).toContain("The last 10 whale moves");
    expect(reply.text.split("\n").length).toBe(12);
  });

  test("says so when there are none, and toggles per chat", async () => {
    expect((await handle(r, "https://app.example", 7, "whales", "", [], db)).text).toContain("No whale moves yet");
    expect((await handle(r, "https://app.example", 7, "whales", "off", [], db)).text).toContain("off");
    expect(await r.isMuted(7, "whales")).toBe(true);
    expect(await r.isMuted(8, "whales")).toBe(false);
    expect((await handle(r, "https://app.example", 7, "whales", "", [], db)).text).toContain("/whales on turns them back on");
    expect((await handle(r, "https://app.example", 7, "whales", " ON ", [], db)).text).toContain("on");
    expect(await r.isMuted(7, "whales")).toBe(false);
    expect((await handle(r, "https://app.example", 7, "whales", "sideways", [], db)).text).toContain("/whales off");
  });

  test("the shipped plugin list includes it", () => {
    expect(PLUGINS.map((p) => p.name)).toContain("whales");
  });
});

describe("GET /whales", () => {
  const api = () => createApi({
    db, repo: r, vaults: async () => [], liveAlarms: async () => [], watchers: [], alarmBook: "0x0000000000000000000000000000000000000001", chainId: 4663, now: () => NOW,
    rateLimit: { perMin: 3, proxyHops: 0 },
  });
  async function seed() {
    const chain = new Chain();
    chain.logs = [move("Withdraw", 1_200_000n, 50n, 80), move("Deposit", 400_000n, 51n, 81)];
    await reader(chain).sync();
    await r.saveCard(VAULT, { name: "Steakhouse USDG" } as never, "card", NOW);
  }

  test("returns recent moves, newest first, with the short wallet and a Blockscout link", async () => {
    await seed();
    const res = await api().request("/whales");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ vault: VAULT, vaultName: "Steakhouse USDG", direction: "in", usd: 400_000, label: "$400K", asset: "USDG", wallet: "0x1234…5678", liquidUsd: 3_000_000 });
    expect(body[1]).toMatchObject({ direction: "out", usd: 1_200_000, pctOfVault: 10.7, txUrl: `https://robinhoodchain.blockscout.com/tx/${tx(80)}` });
    expect(JSON.stringify(body).toLowerCase()).not.toContain(WHALE.toLowerCase());
  });

  test("filters by vault and limits the page", async () => {
    await seed();
    expect(((await (await api().request(`/whales?vault=${VAULT}&limit=1`)).json()) as unknown[]).length).toBe(1);
    expect(await (await api().request(`/whales?vault=${OTHER_VAULT}`)).json()).toEqual([]);
    expect(((await (await api().request(`/whales?vault=${VAULT.toUpperCase().replace("0X", "0x")}`)).json()) as unknown[]).length).toBe(2);
  });

  test("refuses a bad vault or limit, and clamps a big one", async () => {
    expect((await api().request("/whales?vault=nope")).status).toBe(400);
    expect((await api().request("/whales?limit=abc")).status).toBe(400);
    expect((await api().request("/whales?limit=-1")).status).toBe(400);
    expect((await api().request("/whales?limit=99999")).status).toBe(200);
  });

  test("shares the read limit of the other routes", async () => {
    const a = api();
    const codes = [] as number[];
    for (let i = 0; i < 4; i++) codes.push((await a.request("/whales", { headers: { "x-real-ip": "203.0.113.9" } })).status);
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  test("is read-only", async () => {
    expect((await api().request("/whales", { method: "POST" })).status).toBeGreaterThanOrEqual(400);
  });
});
