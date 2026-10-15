import { createPublicClient, createWalletClient, fallback, getAbiItem, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { webhookCallback } from "grammy";
import { alarmBookAbi, erc20Abi } from "./chain/abi";
import { chainParts, ROBINHOOD, txUrl } from "./chain/addresses";
import { isPreset, Kind } from "./api/presets";
import { createApi } from "./api/server";
import { appKeyboard, createBot, notifyFollowers, notifyText } from "./bot/bot";
import { ALARM_NAMES, signalLine, watchAlert } from "./copy/alerts";
import { feedSignal, type Signal } from "./detectors";
import { scanVault } from "./detectors/scan";
import { classifierFor } from "./engine/classifier";
import { loadEnv } from "./env";
import { applyPayment, applyRegistered, applyRouterLog, decodeFired, syncLogs } from "./indexer/indexer";
import { ALARM_TTL, checkpointKeys, claimOwed, drainExits, onFired, pokeAndQueue, type KeeperDeps } from "./keeper/keeper";
import { opsProblems } from "./keeper/ops";
import { serialSender, withMargin } from "./keeper/sender";
import { cardText, readCard } from "./risk/card";
import { migrate, postgres } from "./store/db";
import { repo } from "./store/repo";
import { fetchFeed } from "./watcher/feeds";
import { acceptAttestation, ingestFeed, matchVaults, maybeAttest, quorumCall, recentReports } from "./watcher/watcher";

const env = loadEnv(process.env);
const now = () => Math.floor(Date.now() / 1000);
const transport = fallback([http(env.RPC_URL), http(env.RPC_URL_BACKUP)]);
const client = createPublicClient({ transport, pollingInterval: 500 });
const db = postgres(env.DATABASE_URL);
const r = repo(db);
const router = (env.ROUTER ?? "0x") as Address;
const alarmBook = (env.ALARM_BOOK ?? "0x") as Address;
const run = (role: string) => env.ROLE === "all" || env.ROLE === role;
const contracts = !env.ALERTS_ONLY;
const onRobinhood = env.CHAIN_ID === ROBINHOOD.chainId;
const parts = chainParts(env.CHAIN_ID);

/** Runs a loop forever. One failed pass is logged and retried; it never takes the process down. */
function every(baseMs: number, name: string, fn: () => Promise<unknown>) {
  const ms = baseMs * env.LOOP_SCALE;
  const tick = async () => {
    try {
      await fn();
    } catch (e) {
      console.error(name, (e as Error).message);
    }
    setTimeout(tick, ms);
  };
  void tick();
}

await migrate(db);
const listed = env.CARD_VAULTS.split(",").filter(Boolean).map((v) => v.toLowerCase());
const bot = createBot(env.TELEGRAM_BOT_TOKEN, r, env.PUBLIC_URL, env.TELEGRAM_API_ROOT, listed);
const sendAlert = (chat: number, text: string) => bot.api.sendMessage(chat, text, { reply_markup: appKeyboard(env.PUBLIC_URL) });
const vaultName = async (vault: string) => ((await r.card(vault)) as { numbers?: { name?: string } } | null)?.numbers?.name ?? vault;

const keeper: KeeperDeps | null = contracts && env.KEEPER_PRIVATE_KEY
  ? (() => {
      const account = privateKeyToAccount(env.KEEPER_PRIVATE_KEY as Hex);
      const wallet = createWalletClient({ account, transport });
      const send = serialSender({
        pendingNonce: () => client.getTransactionCount({ address: account.address, blockTag: "pending" }),
        fees: async () => {
          const f = await client.estimateFeesPerGas();
          return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
        },
        send: async (tx, nonce, fees) => wallet.sendTransaction({ ...tx, gas: tx.gas ?? withMargin(await client.estimateGas({ ...tx, account })), nonce, ...fees, chain: null } as never),
        receipt: (hash) => client.getTransactionReceipt({ hash }).catch(() => null),
        sleep: Bun.sleep,
        now: Date.now,
      });
      return {
        client: client as never,
        repo: r,
        router,
        alarmBook,
        multicall3: parts.multicall3,
        morpho: parts.morpho,
        account: account.address,
        send,
        now,
        paidOnly: env.KEEPER_PAID_ONLY,
      };
    })()
  : null;

if (run("indexer") && contracts) {
  every(2_000, "router", () =>
    syncLogs(client, r, { name: "router", address: router, startBlock: env.START_BLOCK, onLog: (l) => applyRouterLog(r, l) }));
  every(2_000, "alarms", () =>
    syncLogs(client, r, {
      name: "alarms",
      address: alarmBook,
      startBlock: env.START_BLOCK,
      onLog: async (l) => {
        if (await applyRegistered(db, l)) return;
        const f = decodeFired(l);
        if (!f) return;
        // Read at the log's own block, because a node a block behind would report no alarm and the exits would be lost.
        const state = await client.readContract({ address: alarmBook, abi: alarmBookAbi, functionName: "state", args: [f.key], blockNumber: l.blockNumber ?? undefined });
        const firedAt = Number(state[1]);
        if (firedAt === 0) throw new Error(`no alarm at ${f.tx}`);
        await r.recordAlarm(f.key, firedAt, f.tx, f.evidence);
        if (keeper) await onFired(keeper, f.key, firedAt);
        const kind = await r.detectorKind(f.key);
        // Anyone can arm a key of their own on a real vault, so followers only hear about the vault's own presets.
        const armed = (await r.vaultsFor(f.key)).filter((v) => isPreset(v as Address, f.key));
        const once = (vault: string) => r.claimAlert(vault, `fired:${f.key}:${firedAt}`, now(), 2 * ALARM_TTL);
        for (const vault of armed) {
          if (!(await once(vault))) continue;
          await notifyFollowers(r, sendAlert, vault, { vaultName: await vaultName(vault), alarm: ALARM_NAMES[kind ?? -1] ?? "an alarm", evidenceUrl: txUrl(env.CHAIN_ID, f.tx) });
        }
        // With nothing armed, the scan already covers on-chain signals. A watcher confirmation has no other route to followers.
        const vault = f.target.toLowerCase();
        if (armed.length === 0 && kind === Kind.QUORUM && isPreset(vault as Address, f.key) && (await once(vault))) {
          await notifyText(r, sendAlert, vault, watchAlert({ vaultName: await vaultName(vault), what: "watchers confirmed a report about it", withdrawInRobinhoodApp: onRobinhood }));
        }
      },
    }));
  every(30_000, "payments", () =>
    syncLogs(client, r, {
      name: "payments",
      address: env.PLAN_TOKEN as Address,
      startBlock: env.START_BLOCK,
      filter: { event: getAbiItem({ abi: erc20Abi, name: "Transfer" }), args: { to: env.PLAN_PAY_ADDRESS } },
      onLog: async (l) => void (await applyPayment(r, l, now())),
    }));
}

const watchers = env.WATCHERS.split(",").filter(Boolean) as Address[];

const firing = new Set<Hex>();

/** Fires a quorum alarm once enough approved signatures match. A keeper sends it; others just hold signatures. */
async function tryQuorum(key: Hex, evidence: Hex, deadline: bigint) {
  if (!keeper || firing.has(key)) return;
  firing.add(key);
  try {
    const call = await quorumCall(db, { key, evidence, deadline }, env.QUORUM, alarmBook);
    if (!call) return;
    const live = await client.readContract({ address: alarmBook, abi: alarmBookAbi, functionName: "isLive", args: [key, 86_400n] });
    if (!live) await keeper.send(call);
  } catch (e) {
    console.error("quorum", (e as Error).message);
  } finally {
    firing.delete(key);
  }
}

if (run("keeper") && keeper) {
  every(1_000, "poke", () => pokeAndQueue(keeper));
  every(1_000, "exits", () => drainExits(keeper));
  // Watchers and the indexer run on other hosts, so this process picks up their work from the shared database.
  every(2_000, "alarm queue", async () => {
    for (const a of await r.recentAlarms(now() - ALARM_TTL)) await onFired(keeper, a.key as Hex, Number(a.fired_at));
  });
  every(2_000, "quorum", async () => {
    for (const q of await r.quorumReady(env.QUORUM, now())) await tryQuorum(q.key as Hex, q.evidence_hash as Hex, BigInt(q.deadline));
  });
  const paidAfter = () => (keeper.paidOnly ? now() : undefined);
  every(3_600_000, "share baselines", async () => checkpointKeys(keeper, (await r.liveKeysOfKind(Kind.SHARE_DROP, paidAfter())) as Hex[]));
  // A DRAIN baseline older than its window can't fire, so this checks far more often than a baseline comes due.
  every(600_000, "drain baselines", async () => checkpointKeys(keeper, (await r.liveKeysOfKind(Kind.DRAIN, paidAfter())) as Hex[]));
  every(86_400_000, "owed", () => claimOwed(keeper));
  every(60_000, "ops", async () => {
    const gasWei = await client.getBalance({ address: keeper.account });
    await r.setCounter("keeper_gas_wei", gasWei);
    if (env.OPS_CHAT_ID === undefined) return;
    const tip = await client.getBlockNumber();
    const seen = await Promise.all(["router", "alarms"].map((c) => r.cursor(c)));
    const cursor = seen.reduce<bigint>((low, c) => (c !== null && c < low ? c : low), tip);
    const { oldestJobSec } = await r.health(now());
    for (const p of opsProblems({ lagBlocks: tip > cursor ? tip - cursor : 0n, gasWei, minGasWei: env.KEEPER_MIN_GAS_WEI, oldestJobSec, maxLagBlocks: parts.maxLagBlocks })) {
      if (await r.claimAlert("ops", p.code, now(), 3600)) await bot.api.sendMessage(env.OPS_CHAT_ID, p.text);
    }
  });
}

/** Vaults people are in, plus the app's supported list, so a risk card is there before anyone arms. */
const trackedVaults = async () => {
  const rows = await db.query<{ target: string }>(`SELECT DISTINCT target FROM positions UNION SELECT DISTINCT target FROM vault_follows`);
  return [...new Set([...rows.map((x) => x.target), ...listed])];
};

if (run("detector")) {
  every(600_000, "cards", async () => {
    for (const target of await trackedVaults()) {
      try {
        // Followers can name a vault on another chain. That chain's operator builds its card.
        if (!(await client.getCode({ address: target as Address }))) continue;
        const c = await readCard(client as never, target as Address);
        await r.saveCard(target, c, cardText(c), now());
      } catch (e) {
        console.error("card", target, (e as Error).message);
      }
    }
  });
  every(60_000, "scans", async () => {
    for (const target of await trackedVaults()) {
      try {
        for (const s of await scanVault({ client, repo: r, now }, target as Address)) {
          if (!(await r.claimAlert(target, s.kind, now()))) continue;
          await notifyText(r, sendAlert, target, watchAlert({ vaultName: await vaultName(target), what: signalLine(s.kind, s.value), withdrawInRobinhoodApp: onRobinhood }));
        }
      } catch (e) {
        console.error("scan", target, (e as Error).message);
      }
    }
  });
}
