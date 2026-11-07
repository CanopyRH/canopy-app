import { isAddress } from "viem";
import { txUrl } from "../chain/addresses";
import { WHALES_MUTED, WHALES_UNMUTED, WHALES_USAGE, WHALE_TOPIC, shortWallet, usdShort, whalesList, type MoveView } from "../copy/whales";
import type { Plugin } from "../plugins";
import { whaleConfig } from "../whales/config";
import { whaleStore } from "../whales/store";
import { whaleReader } from "../whales/sync";

/**
 * Whale alerts: a big deposit or withdrawal on a listed vault is recorded, announced to the vault's followers, and shown at
 * GET /whales and in the bot's /whales. The reader is in ../whales/sync.ts, its table in ../store/schema.d/whales.sql.
 */
export const LIST_LIMIT = 10;
export const API_DEFAULT_LIMIT = 20;
export const API_MAX_LIMIT = 100;

const plugin: Plugin = {
  name: "whales",

  start(rt) {
    const cfg = whaleConfig(process.env);
    if (!cfg.watch || rt.listed.length === 0) return;
    // The loop that sends queued alerts runs in the indexer role, or in the detector role on a chain with no Canopy contracts.
    if (!(rt.contracts ? rt.run("indexer") : rt.run("detector"))) return;
    const reader = whaleReader({
      client: rt.client, repo: rt.repo, db: rt.db, chainId: rt.chainId, now: rt.now, listed: rt.listed, confirmations: rt.confirmations, cfg,
      fence: rt.fence, onStuck: rt.onStuck, onDeepReorg: rt.onDeepReorg, queueAlert: (vault, text, tag, topic) => rt.queueAlert(vault, text, tag, topic),
    });
    rt.every(2_000, "whales", () => reader.sync());
    rt.every(3_600_000, "whales prune", () => reader.store.prune(rt.now()));
  },

  api(app, d) {
    const store = whaleStore(d.db);
    app.get("/whales", async (c) => {
      const v = c.req.query("vault");
      if (v !== undefined && !isAddress(v)) return c.json({ error: "bad address" }, 400);
      const asked = c.req.query("limit");
      if (asked !== undefined && !/^\d{1,6}$/.test(asked)) return c.json({ error: "bad limit" }, 400);
      const limit = Math.min(Math.max(Number.parseInt(asked ?? "", 10) || API_DEFAULT_LIMIT, 1), API_MAX_LIMIT);
      const rows = await store.recent({ vault: v?.toLowerCase(), limit });
      // The whale's address is public on chain, but it is shown shortened here too.
      return c.json(rows.map((m) => ({
        vault: m.vault,
        vaultName: m.name,
        direction: m.dir,
        asset: m.symbol,
        usd: Number(m.usdCents) / 100,
        label: usdShort(m.usdCents),
        pctOfVault: Math.round(m.pctBps / 10) / 10,
        liquidUsd: m.liquidCents === null ? null : Number(m.liquidCents) / 100,
        wallet: shortWallet(m.whale),
        tx: m.tx,
        txUrl: txUrl(d.chainId, m.tx) ?? null,
        block: Number(m.block),
        at: m.at,
      })));
    });
  },

  commands: {
    async whales({ db, repo, chatId, arg }) {
      const a = arg.trim().toLowerCase();
      if (a === "off" || a === "on") {
        await repo.setMuted(chatId, WHALE_TOPIC, a === "off");
        return { text: a === "off" ? WHALES_MUTED : WHALES_UNMUTED };
      }
      if (a !== "") return { text: WHALES_USAGE };
      const rows = await whaleStore(db).recent({ limit: LIST_LIMIT });
      const views: MoveView[] = rows.map((m) => ({
        dir: m.dir, vaultName: m.name ?? shortWallet(m.vault), usdCents: m.usdCents, pctBps: m.pctBps, liquidCents: m.liquidCents, wallet: m.whale, tx: m.tx, at: m.at,
      }));
      return { text: whalesList(views, Math.floor(Date.now() / 1000), await repo.isMuted(chatId, WHALE_TOPIC)) };
    },
  },
};

export default plugin;
