import { Bot, InlineKeyboard } from "grammy";
import { isAddress } from "viem";
import { alarmAlert, DISARM_BUTTON, EXIT_BUTTON, EXIT_USAGE, exitButtonFor, exitMany, exitNotFound, exitReply, PANIC_NO_VAULTS, PANIC_TEXT, RISK_BUTTON, WELCOME, type AlertInput } from "../copy/alerts";
import { disarmAllLink, exitLink, riskLink } from "./links";
import type { Repo } from "../store/repo";
import type { Db } from "../store/db";
import { PLUGINS, type Plugin } from "../plugins";

export interface Reply { text: string; keyboard?: InlineKeyboard }

const MAX_FOLLOWS = 20;
/** Distinct vaults followed across every chat. Each one is scanned every minute, so the total has to stop somewhere. */
export const MAX_FOLLOWED_VAULTS = 500;
const MAX_MESSAGE = 4000; // Telegram's limit is 4096.
const BUILT_IN = ["start", "vaults", "watch", "unwatch", "list", "card", "exit", "panic"];

export const appKeyboard = (url: string) => new InlineKeyboard().url("Open Canopy", url);

/** The buttons under an alert for one vault. Both open the web app, where the user's own wallet signs. */
export const alertKeyboard = (appUrl: string, vault: string) =>
  new InlineKeyboard().url(EXIT_BUTTON, exitLink(appUrl, vault)).row().url(RISK_BUTTON, riskLink(appUrl, vault));

const shortAddress = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`;
const vaultName = async (r: Repo, v: string) => ((await r.card(v)) as { numbers?: { name?: string } } | null)?.numbers?.name ?? shortAddress(v);

/** Command logic, kept apart from Telegram so it can be tested. It stores chats and vaults, never wallets. */
export async function handle(
  r: Repo, publicUrl: string, chatId: number, cmd: string, arg: string, listed: string[] = [], db?: Db, plugins: Plugin[] = PLUGINS,
): Promise<Reply> {
  const vault = arg.trim().toLowerCase();
  switch (cmd) {
    case "start":
      return { text: WELCOME, keyboard: appKeyboard(publicUrl) };
    case "vaults": {
      const list = await r.cardList(listed);
      return { text: list.length ? list.map((v) => `${v.name ?? "Unnamed vault"}: ${v.target}`).join("\n").slice(0, MAX_MESSAGE) : "No vaults are listed yet." };
    }
    case "watch":
      if (!isAddress(vault)) return { text: "Send a vault address: /watch 0x..." };
      if ((await r.followCount(chatId)) >= MAX_FOLLOWS) return { text: `You can follow up to ${MAX_FOLLOWS} vaults. Use /unwatch to free one up.` };
      // A vault someone already follows, or a listed one, costs nothing more to watch.
      if (!listed.some((v) => v.toLowerCase() === vault) && !(await r.isFollowed(vault)) && (await r.followedTargets()) >= MAX_FOLLOWED_VAULTS) {
        return { text: "Canopy is watching as many vaults as it can right now, so it can't add this one. The listed vaults in /vaults can always be followed." };
      }
      await r.follow(chatId, vault);
      return { text: `Following ${vault}. You'll get an alert if an alarm fires.` };
    case "unwatch":
      if (!isAddress(vault)) return { text: "Send a vault address: /unwatch 0x..." };
      await r.unfollow(chatId, vault);
      return { text: `Stopped following ${vault}.` };
    case "list": {
      const v = await r.following(chatId);
      return { text: v.length ? v.join("\n").slice(0, MAX_MESSAGE) : "You aren't following any vaults yet." };
    }
    case "card": {
      if (!isAddress(vault)) return { text: "Send a vault address: /card 0x..." };
      const c = await r.card(vault);
      return { text: (c?.text ?? "No card for that vault yet.").slice(0, MAX_MESSAGE) };
    }
    case "exit": {
      const q = arg.trim();
      if (!q) return { text: EXIT_USAGE };
      if (isAddress(q, { strict: false })) {
        const v = q.toLowerCase();
        return { text: exitReply(await vaultName(r, v)), keyboard: new InlineKeyboard().url(EXIT_BUTTON, exitLink(publicUrl, v)) };
      }
      // A name: look among the vaults this chat follows and the listed ones.
      const pool = [...new Set([...(await r.following(chatId)), ...listed.map((v) => v.toLowerCase())])];
      const named = await Promise.all(pool.map(async (v) => ({ v, name: await vaultName(r, v) })));
      const hits = named.filter((x) => x.name.toLowerCase().includes(q.toLowerCase()));
      const exact = hits.filter((x) => x.name.toLowerCase() === q.toLowerCase());
      const pick = exact.length === 1 ? exact : hits;
      if (pick.length === 0) return { text: exitNotFound(q) };
      if (pick.length === 1) return { text: exitReply(pick[0]!.name), keyboard: new InlineKeyboard().url(EXIT_BUTTON, exitLink(publicUrl, pick[0]!.v)) };
      const kb = new InlineKeyboard();
      for (const x of pick.slice(0, 8)) kb.url(exitButtonFor(x.name), exitLink(publicUrl, x.v)).row();
      return { text: exitMany, keyboard: kb };
    }
    case "panic": {
      const followed = await r.following(chatId);
      const kb = new InlineKeyboard().url(DISARM_BUTTON, disarmAllLink(publicUrl)).row();
      for (const v of followed) kb.url(exitButtonFor(await vaultName(r, v)), exitLink(publicUrl, v)).row();
      return { text: followed.length ? PANIC_TEXT : `${PANIC_TEXT}\n\n${PANIC_NO_VAULTS}`, keyboard: kb };
    }
    default: {
      // Feature commands come from src/plugins/ and need the database for their own tables.
      const run = plugins.find((p) => p.commands?.[cmd])?.commands?.[cmd];
      if (!db || !run) return { text: WELCOME };
      const reply = await run({ db, repo: r, chatId, arg, appUrl: publicUrl });
      return { ...reply, text: reply.text.slice(0, MAX_MESSAGE) };
    }
  }
}

export function createBot(token: string, r: Repo, publicUrl: string, apiRoot?: string, listed: string[] = [], db?: Db, plugins: Plugin[] = PLUGINS) {
  const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : {});
  const extra = db ? plugins.flatMap((p) => Object.keys(p.commands ?? {})).filter((c) => !BUILT_IN.includes(c)) : [];
  for (const cmd of [...BUILT_IN, ...extra]) {
    bot.command(cmd, async (ctx) => {
      const reply = await handle(r, publicUrl, ctx.chat.id, cmd, ctx.match?.toString() ?? "", listed, db, plugins);
      await ctx.reply(reply.text, reply.keyboard ? { reply_markup: reply.keyboard } : {});
    });
  }
  // A failed reply must not answer the webhook with an error, or Telegram sends the same update again.
  bot.catch((e) => console.warn("bot", e.message));
  return bot;
}

/** Sends one alert to everyone following a vault (except chats that muted its topic). A failed chat never stops the rest. */
export async function notifyText(r: Repo, send: (chatId: number, text: string, vault: string) => Promise<unknown>, target: string, text: string, topic?: string) {
  let sent = 0;
  for (const chat of await r.followers(target, topic)) {
    try {
      await send(chat, text, target).catch(async (e: { error_code?: number; parameters?: { retry_after?: number } }) => {
        if (e.error_code !== 429) throw e;
        await Bun.sleep((e.parameters?.retry_after ?? 1) * 1000);
        await send(chat, text, target);
      });
      sent++;
    } catch {
      // A blocked bot or deleted chat is not an error worth stopping for.
    }
  }
  return sent;
}

export const notifyFollowers = (r: Repo, send: (chatId: number, text: string, vault: string) => Promise<unknown>, target: string, a: AlertInput) =>
  notifyText(r, send, target, alarmAlert(a));
