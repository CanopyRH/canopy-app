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
