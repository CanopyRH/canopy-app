import { createPublicClient, createWalletClient, fallback, getAbiItem, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { webhookCallback } from "grammy";
import { alarmBookAbi, erc20Abi, vaultAbi } from "./chain/abi";
import { chainParts, ROBINHOOD, txUrl } from "./chain/addresses";
import { isPreset, Kind } from "./api/presets";
import { createApi } from "./api/server";
import { appKeyboard, createBot, notifyText } from "./bot/bot";
import { queueAlert as enqueueAlert, queueOps, sendQueuedAlerts, sendQueuedOps } from "./bot/queue";
import { ALARM_NAMES, alarmAlert, watchAlert } from "./copy/alerts";
import { feedSignal, type Signal } from "./detectors";
import { scanAll, SCAN_BUDGET_MS, withinMs } from "./detectors/loop";
import { classifierFor } from "./engine/classifier";
import { loadEnv } from "./env";
import { adminAlertId, adminAlertText, type AdminEvent } from "./indexer/admin";
import { deepReorgText, stuckLogText, type StuckLog } from "./indexer/retry";
import { applyAlarmAdmin, applyPayment, applyRegistered, applyRouterLog, confirmArms, decodeFired, recheckRouter, syncLogs, type ReorgInfo } from "./indexer/indexer";
import { ALARM_TTL, checkpointKeys, claimOwed, drainExits, gasFor, onFired, pokeAndQueue, queueNewAlarms, SMALL_CALL_GAS, type AlarmCursor, type KeeperDeps } from "./keeper/keeper";
import { opsProblems } from "./keeper/ops";
import { serialSender } from "./keeper/sender";
import { cardText, readCard } from "./risk/card";
import { migrate, postgres } from "./store/db";
import { repo } from "./store/repo";
import { scrubConsole } from "./log";
import { fetchFeed } from "./watcher/feeds";
import { quorumScope, quorumScopeNow } from "./watcher/scope";
import { acceptAttestation, ingestFeed, matchVaults, maybeAttest, quorumCall, recentReports } from "./watcher/watcher";

scrubConsole();
const env = loadEnv(process.env);
const now = () => Math.floor(Date.now() / 1000);
const transport = fallback([http(env.RPC_URL), http(env.RPC_URL_BACKUP)]);
const client = createPublicClient({ transport, pollingInterval: 500 });
const db = postgres(env.DATABASE_URL, env.DB_POOL);
const r = repo(db);
const router = (env.ROUTER ?? "0x") as Address;
const alarmBook = (env.ALARM_BOOK ?? "0x") as Address;
const run = (role: string) => env.ROLE === "all" || env.ROLE === role;
const contracts = !env.ALERTS_ONLY;
const onRobinhood = env.CHAIN_ID === ROBINHOOD.chainId;
const parts = chainParts(env.CHAIN_ID);
const confirmations = env.CONFIRMATIONS ?? parts.confirmations;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let stopped = false;
/** The web server, when this process runs the api or bot role. */
export let server: ReturnType<typeof Bun.serve> | undefined;

/** Runs a loop forever. One failed pass is logged and retried; it never takes the process down. */
function every(baseMs: number, name: string, fn: () => Promise<unknown>) {
  const ms = baseMs * env.LOOP_SCALE;
  const tick = async () => {
    try {
      await fn();
    } catch (e) {
      console.error(name, (e as Error).message);
    }
    if (!stopped) timers.set(name, setTimeout(tick, ms));
  };
  void tick();
}

/** Ends every loop and the web server. Only tests call this: a running service is stopped by its host. */
export function stop() {
  stopped = true;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  server?.stop(true);
}

await migrate(db);
const listed = env.CARD_VAULTS.split(",").filter(Boolean).map((v) => v.toLowerCase());
// Bot buttons open the web app, which is a different host from this service's webhook address.
const appUrl = env.APP_URL ?? env.PUBLIC_URL;
const bot = createBot(env.TELEGRAM_BOT_TOKEN, r, appUrl, env.TELEGRAM_API_ROOT, listed, db);
const sendAlert = (chat: number, text: string) => bot.api.sendMessage(chat, text, { reply_markup: appKeyboard(appUrl) });
const queueAlert = (vault: string, text: string) => enqueueAlert(r, vault, text, now());
const vaultName = async (vault: string) => ((await r.card(vault)) as { numbers?: { name?: string } } | null)?.numbers?.name ?? vault;

const keeper: KeeperDeps | null = contracts && env.KEEPER_PRIVATE_KEY
  ? (() => {
      const account = privateKeyToAccount(env.KEEPER_PRIVATE_KEY as Hex);
      const wallet = createWalletClient({ account, transport });
      const fees = async () => {
        const f = await client.estimateFeesPerGas();
        return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
      };
      const send = serialSender({
        pendingNonce: () => client.getTransactionCount({ address: account.address, blockTag: "pending" }),
        fees,
        // Every keeper path sets a limit from its own simulation. A send without one is a bug, never a reason to estimate.
        send: async (tx, nonce, fees) => {
          if (tx.gas === undefined) throw new Error("refusing a keeper transaction with no gas limit");
          return wallet.sendTransaction({ ...tx, gas: tx.gas, nonce, ...fees, chain: null } as never);
        },
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
        listed: new Set(listed),
        fees,
        unlistedExitGas: env.KEEPER_UNLISTED_EXIT_GAS,
      };
    })()
  : null;

/** Admin and guardian changes go to the operator chat. This only queues a row, so the indexer never waits on Telegram. */
const adminAlert = async (e: AdminEvent) => {
  if (env.OPS_CHAT_ID === undefined) return void console.warn("admin event", e.event, "(set OPS_CHAT_ID to be told)");
  await queueOps(r, adminAlertId(e), adminAlertText(env.CHAIN_ID, e), now());
};

/** A log that has been failing for a while goes to the operator chat. It keeps being retried either way. */
const stuckAlert = async (s: StuckLog) => {
  if (env.OPS_CHAT_ID === undefined) return void console.error("log stuck", s.source, s.tx, s.error);
  await queueOps(r, `stuck:${s.source}:${s.tx}:${s.logIndex}`, stuckLogText(env.CHAIN_ID, s), now());
};

/** A reorg deeper than the remembered blocks goes to the operator chat, through the same queue. */
const reorgAlert = async (i: ReorgInfo) => {
  if (env.OPS_CHAT_ID === undefined) return void console.error("deep reorg", i.source, `cursor ${i.cursor}`, `rewound to ${i.rewoundTo}`);
  await queueOps(r, `reorg:${i.source}:${i.cursor}:${i.rewoundTo}`, deepReorgText(i), now());
};

if (run("indexer") && contracts) {
  every(2_000, "router", () =>
    syncLogs(client, r, {
      name: "router",
      address: router,
      startBlock: env.START_BLOCK,
      onStuck: stuckAlert,
      onLog: (l) => applyRouterLog(r, l, adminAlert),
      onRewind: (from) => r.undoRouter(from),
      recheck: (subjects, at) => recheckRouter(client, r, router, subjects, at),
      onDeepReorg: reorgAlert,
    }));
  every(2_000, "alarms", () =>
    syncLogs(client, r, {
      name: "alarms",
      onStuck: stuckAlert,
      onRewind: (from) => r.undoAlarms(from),
      onDeepReorg: reorgAlert,
      address: alarmBook,
      startBlock: env.START_BLOCK,
      onLog: async (l) => {
        if (await applyAlarmAdmin(l, adminAlert)) return;
        if (await applyRegistered(db, l)) return;
        const f = decodeFired(l);
        if (!f) return;
        // Read at the log's own block, because a node a block behind would report no alarm and the exits would be lost.
        const state = await client.readContract({ address: alarmBook, abi: alarmBookAbi, functionName: "state", args: [f.key], blockNumber: l.blockNumber ?? undefined });
        const firedAt = Number(state[1]);
        if (firedAt === 0) throw new Error(`no alarm at ${f.tx}`);
        await r.recordAlarm(f.key, firedAt, f.tx, f.evidence, l.blockNumber);
        if (keeper) await onFired(keeper, f.key, firedAt);
        const kind = await r.detectorKind(f.key);
        // Anyone can arm a key of their own on a real vault, so followers only hear about the vault's own presets.
        const armed = (await r.vaultsFor(f.key)).filter((v) => isPreset(v as Address, f.key));
        const once = (vault: string) => r.claimAlert(vault, `fired:${f.key}:${firedAt}`, now(), 2 * ALARM_TTL);
        for (const vault of armed) {
          if (!(await once(vault))) continue;
          await queueAlert(vault, alarmAlert({ vaultName: await vaultName(vault), alarm: ALARM_NAMES[kind ?? -1] ?? "an alarm", evidenceUrl: txUrl(env.CHAIN_ID, f.tx) }));
        }
        // With nothing armed, the scan already covers on-chain signals. A watcher confirmation has no other route to followers.
        const vault = f.target.toLowerCase();
        if (armed.length === 0 && kind === Kind.QUORUM && isPreset(vault as Address, f.key) && (await once(vault))) {
          await queueAlert(vault, watchAlert({ vaultName: await vaultName(vault), what: "watchers confirmed a report about it", withdrawInRobinhoodApp: onRobinhood }));
        }
      },
    }));
  // Arms are applied at the tip, so exits stay fast. Each is checked against the chain once it is deep enough to be settled.
  every(5_000, "confirm arms", () => confirmArms(client, r, router, confirmations));
  // Alerts go out from their own loop, so a slow or rate-limited Telegram never holds up reading the next alarm.
  every(1_000, "alerts", () => sendQueuedAlerts(r, (vault, text) => notifyText(r, sendAlert, vault, text), now));
  const opsChat = env.OPS_CHAT_ID;
  if (opsChat !== undefined) every(1_000, "ops alerts", () => sendQueuedOps(r, (text) => bot.api.sendMessage(opsChat, text), now));
  every(30_000, "payments", () =>
    syncLogs(client, r, {
      name: "payments",
      onStuck: stuckAlert,
      // A plan is credited only once its payment is buried a few blocks, so a reorged-away transfer can't buy one.
      confirmations,
      // A reorg deeper than the depth can drop a credited payment. A transfer that comes back credits nothing more.
      onRewind: async (from) => void (await r.bump("payments_reorged_after_credit", await r.undoPayments(from))),
      onDeepReorg: reorgAlert,
      address: env.PLAN_TOKEN as Address,
      startBlock: env.START_BLOCK,
      filter: { event: getAbiItem({ abi: erc20Abi, name: "Transfer" }), args: { to: env.PLAN_PAY_ADDRESS } },
      onLog: async (l) => void (await applyPayment(r, l, now())),
    }));
}

const watchers = env.WATCHERS.split(",").filter(Boolean) as Address[];
const inScope = quorumScope(r, listed, now, env.KEEPER_PAID_ONLY);

const firing = new Set<Hex>();

/** Fires a quorum alarm once enough approved signatures match. A keeper sends it; others just hold signatures. */
async function tryQuorum(key: Hex, evidence: Hex, deadline: bigint) {
  if (!keeper || firing.has(key)) return;
  firing.add(key);
  try {
    const call = await quorumCall(db, { key, evidence, deadline }, env.QUORUM, alarmBook);
    if (!call) return;
    // Firing costs gas, so it's spent only on alarms in scope: a listed vault's preset, or one a position armed.
    if (!(await inScope(key, await r.detectorTarget(key)))) return;
    const live = await client.readContract({ address: alarmBook, abi: alarmBookAbi, functionName: "isLive", args: [key, 86_400n] });
    if (live) return;
    const g = await gasFor(keeper, call, SMALL_CALL_GAS);
    if (g) await keeper.send({ ...call, gas: g.gas });
  } catch (e) {
    console.error("quorum", (e as Error).message);
  } finally {
    firing.delete(key);
  }
}

if (run("keeper") && keeper) {
  every(1_000, "poke", () => pokeAndQueue(keeper));
  // Listed vaults' exits run in a loop of their own, so a queue of slow or costly jobs elsewhere never waits in front of them.
  if (listed.length > 0) {
    every(1_000, "exits", () => drainExits(keeper, "listed"));
    every(1_000, "exits unlisted", () => drainExits(keeper, "unlisted"));
  } else every(1_000, "exits", () => drainExits(keeper));
  // Watchers and the indexer run on other hosts, so this process picks up their work from the shared database: new
  // alarms from a cursor every 2 s, and the whole day's again once a minute for positions armed since an alarm fired.
  const alarmCursor: AlarmCursor = { seq: 0n, sweptAt: 0 };
  every(2_000, "alarm queue", () => queueNewAlarms(keeper, alarmCursor));
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

/** Vaults people are in or follow that aren't on the app's supported list. Anyone can add to these. */
const otherVaults = async () => {
  const rows = await db.query<{ target: string }>(`SELECT DISTINCT target FROM positions UNION SELECT DISTINCT target FROM vault_follows`);
  return [...new Set(rows.map((x) => x.target.toLowerCase()))].filter((t) => !listed.includes(t));
};

if (run("detector")) {
  // The supported list first, so a risk card is there before anyone arms, and no followed contract can delay it.
  every(600_000, "cards", async () => {
    for (const target of [...listed, ...(await otherVaults())]) {
      try {
        await withinMs((async () => {
          // Followers can name a vault on another chain. That chain's operator builds its card.
          if (!(await client.getCode({ address: target as Address }))) return;
          const c = await readCard(client as never, target as Address);
          await r.saveCard(target, c, cardText(c), now());
        })(), SCAN_BUDGET_MS, "card");
      } catch (e) {
        console.error("card", target, (e as Error).message);
      }
    }
  });
  // Listed vaults are scanned in a loop of their own: their signals feed the watchers, and anyone can follow any contract.
  const scans = { client, repo: r, now, vaultName, withdrawInRobinhoodApp: onRobinhood, queue: (vault: string, text: string, tag: string) => enqueueAlert(r, vault, text, now(), tag) };
  every(60_000, "scans", () => scanAll(scans, listed));
  every(60_000, "scans followed", async () => scanAll(scans, await otherVaults()));
  // Done jobs, old alarms, signals, attestations, reports and vault readings only take space. Every operator runs a detector.
  every(3_600_000, "prune", () => r.prune(now()));
  // On a chain with no Canopy contracts the indexer role has nothing to do, so the scan's alerts go out from here.
  if (!contracts) every(1_000, "alerts", () => sendQueuedAlerts(r, (vault, text) => notifyText(r, sendAlert, vault, text), now));
}

if (run("watcher") && contracts && env.WATCHER_PRIVATE_KEY && env.ANTHROPIC_API_KEY) {
  const account = privateKeyToAccount(env.WATCHER_PRIVATE_KEY as Hex);
  const classify = classifierFor(env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL, env.CLASSIFIER_MODEL);
  const urls = env.FEED_URLS.split(",").filter(Boolean);
  const peers = env.WATCHER_PEERS.split(",").filter(Boolean);
  every(60_000, "feeds", async () => {
    for (const url of urls) {
      for (const text of await fetchFeed(url, now())) {
        await ingestFeed(db, classify, url, text, now()).catch((e: Error) => console.warn("feed item", e.message));
      }
    }
    const keys = await db.query<{ key: Hex; target: Hex; name: string; curator: string; asset: string }>(
      `SELECT d.key, d.target, COALESCE(c.numbers->>'name', '') AS name, COALESCE(c.numbers->>'curator', '') AS curator, COALESCE(c.numbers->>'assetSymbol', '') AS asset
       FROM detectors d LEFT JOIN risk_cards c ON c.target=d.target WHERE d.kind=5`,
    );
    // Anyone can register a watcher alarm on any contract, so watchers only sign the ones in scope. Live keys are read once a pass.
    const inScopeNow = await quorumScopeNow(r, listed, now, env.KEEPER_PAID_ONLY);
    const scoped = keys.filter((k) => inScopeNow(k.key, k.target));
    for (const item of await recentReports(db, now() - 3600)) {
      for (const { key, target } of matchVaults(item.classification.protocol, scoped, item.classification.label)) {
        if (await r.firedSince(key, now() - 86_400)) continue;
        const feed = feedSignal(item.classification, target, now(), item.hash);
        if (!feed) continue;
        const soft = (await r.recentSignals(target, now() - 3600)) as Signal[];
        const a = await maybeAttest(account, alarmBook, env.CHAIN_ID, key, [...soft, feed], now());
        if (!a) continue;
        await acceptAttestation(db, watchers, alarmBook, env.CHAIN_ID, a, now());
        const body = JSON.stringify({ ...a, deadline: a.deadline.toString() });
        await Promise.allSettled(peers.map((p) => fetch(`${p}/watcher/attest`, { method: "POST", body, signal: AbortSignal.timeout(5_000) })));
        await tryQuorum(a.key, a.evidence, a.deadline);
      }
    }
  });
}

/** Vaults seen to answer `paused()`. A refusal is remembered for ten minutes, a yes for good. */
const pausedSeen = new Map<string, { yes: boolean; until: number }>();
const answersPaused = async (vault: Address) => {
  const k = vault.toLowerCase();
  const seen = pausedSeen.get(k);
  if (seen && (seen.yes || seen.until > now())) return seen.yes;
  const yes = await client.readContract({ address: vault, abi: vaultAbi, functionName: "paused" }).then(() => true, () => false);
  if (pausedSeen.size > 10_000) pausedSeen.clear();
  pausedSeen.set(k, { yes, until: now() + 600 });
  return yes;
};

if (run("api") || run("bot")) {
  // grammY refuses polling once a webhook handler exists, so polling mode never creates one.
  const hook = env.BOT_MODE === "webhook" ? webhookCallback(bot, "std/http") : null;
  const app = createApi({
    db,
    repo: r,
    vaults: async () => {
      const rows = await r.cardList(listed);
      return rows.map((x) => ({ address: x.target as Address, name: x.name ?? "", asset: x.asset ?? "", chainId: env.CHAIN_ID }));
    },
    liveAlarms: (page) => r.liveAlarms(now() - ALARM_TTL, page.limit, page.before),
    watchers,
    alarmBook,
    chainId: env.CHAIN_ID,
    now,
    onAttested: tryQuorum,
    telegramSecret: env.TELEGRAM_WEBHOOK_SECRET,
    // In polling mode the webhook route has no handler, so it refuses every request.
    telegram: hook ? async (u) => void (await hook(new Request("http://local", { method: "POST", body: JSON.stringify(u) }))) : undefined,
    healthToken: env.HEALTH_TOKEN,
    rateLimit: { perMin: env.RATE_LIMIT_PER_MIN, proxyHops: env.TRUSTED_PROXY_HOPS },
    answersPaused,
    health: async () => {
      const tip = await client.getBlockNumber();
      const cursor = await r.cursor("router");
      return { chainId: env.CHAIN_ID, tip: tip.toString(), lagBlocks: cursor === null ? null : Number(tip > cursor ? tip - cursor : 0n), watchersApproved: watchers.length, ...(await r.health(now())) };
    },
  });
  server = Bun.serve({ port: env.PORT, fetch: app.fetch });
  if (env.BOT_MODE === "polling") void bot.start();
}