import { beforeEach, describe, expect, test } from "bun:test";
import type { InlineKeyboard } from "grammy";
import { alertKeyboard, handle, notifyText } from "../src/bot/bot";
import { disarmAllLink, exitLink, riskLink } from "../src/bot/links";
import { alarmAlert, DISARM_BUTTON, EXIT_BUTTON, EXIT_HINT, PANIC_NO_VAULTS, PANIC_TEXT, RISK_BUTTON } from "../src/copy/alerts";
import { repo, type Repo } from "../src/store/repo";
import { findBanned } from "../../tools/banned-words";
import { freshDb } from "./db";

const APP = "https://app.example.test/app.html";
const V1 = "0x00000000000000000000000000000000000000a1";
const V2 = "0x00000000000000000000000000000000000000b2";
const chat = 7;
let r: Repo;
beforeEach(async () => {
  r = repo(await freshDb());
  await r.saveCard(V1, { name: "Steady USDG" }, "card one", 1);
  await r.saveCard(V2, { name: "Steady Stocks" }, "card two", 1);
});

const buttons = (k?: InlineKeyboard) => (k?.inline_keyboard ?? []).flat().map((b) => ({ text: b.text, url: "url" in b ? b.url : undefined }));

describe("deep links the bot builds", () => {
  test("carry the vault or the action and nothing else", () => {
    expect(exitLink(APP, V1)).toBe(`${APP}#exit=${V1}`);
    expect(riskLink(APP, V1)).toBe(`${APP}#risk=${V1}`);
    expect(disarmAllLink(APP)).toBe(`${APP}#disarm-all`);
  });
  test("lowercase the vault, replace an older fragment and refuse a non-address", () => {
    expect(exitLink(`${APP}#0xabc`, V1.toUpperCase().replace("0X", "0x"))).toBe(`${APP}#exit=${V1}`);
    expect(() => exitLink(APP, "not a vault")).toThrow();
    expect(() => exitLink(APP, `${V1}&amount=5`)).toThrow();
  });
});

describe("alert buttons", () => {
  test("every alert for a vault gets Exit now and Open risk card, as links only", () => {
    const b = buttons(alertKeyboard(APP, V1));
    expect(b).toEqual([{ text: EXIT_BUTTON, url: `${APP}#exit=${V1}` }, { text: RISK_BUTTON, url: `${APP}#risk=${V1}` }]);
    expect(EXIT_BUTTON).toBe("Exit now");
    expect(RISK_BUTTON).toBe("Open risk card");
  });
  test("followers are sent the text with the vault their alert is about", async () => {
    await r.follow(1, V1);
    await r.follow(2, V1);
    await r.follow(3, V2);
    const sent: [number, string][] = [];
    const n = await notifyText(r, async (c, _t, v) => void sent.push([c, v]), V1, "alarm");
    expect(n).toBe(2);
    expect(sent.sort()).toEqual([[1, V1], [2, V1]]);
  });
  test("the alarm text points to the buttons and says Canopy never signs", () => {
    const t = alarmAlert({ vaultName: "Steady USDG", alarm: "a price alarm" });
    expect(t).toContain(EXIT_HINT);
    expect(EXIT_HINT).toContain("Canopy never signs for you");
    expect(alarmAlert({ vaultName: "x", alarm: "y", withdrawInRobinhoodApp: true })).not.toContain(EXIT_HINT);
  });
});

describe("/exit", () => {
  test("a vault address replies with the Exit now button", async () => {
    const out = await handle(r, APP, chat, "exit", V1.toUpperCase().replace("0X", "0x"));
    expect(buttons(out.keyboard)).toEqual([{ text: EXIT_BUTTON, url: `${APP}#exit=${V1}` }]);
    expect(out.text).toContain("Steady USDG");
    expect(out.text).toContain("Canopy never signs for you");
  });
  test("a name finds a followed or listed vault", async () => {
    await r.follow(chat, V1);
    const out = await handle(r, APP, chat, "exit", "steady usdg");
    expect(buttons(out.keyboard)).toEqual([{ text: EXIT_BUTTON, url: `${APP}#exit=${V1}` }]);
    const listed = await handle(r, APP, 99, "exit", "stocks", [V2]);
    expect(buttons(listed.keyboard).map((b) => b.url)).toEqual([`${APP}#exit=${V2}`]);
  });
  test("a name that matches several vaults offers a button for each", async () => {
    await r.follow(chat, V1);
    await r.follow(chat, V2);
    const out = await handle(r, APP, chat, "exit", "steady");
    expect(buttons(out.keyboard)).toEqual([{ text: "Exit Steady USDG", url: `${APP}#exit=${V1}` }, { text: "Exit Steady Stocks", url: `${APP}#exit=${V2}` }]);
  });
  test("nothing, or an unknown name, gets guidance and no button", async () => {
    const none = await handle(r, APP, chat, "exit", "");
    expect(none.text).toContain("/exit");
    expect(none.keyboard).toBeUndefined();
    const unknown = await handle(r, APP, chat, "exit", "nonesuch");
    expect(unknown.text).toContain("No vault found");
    expect(unknown.keyboard).toBeUndefined();
  });
  test("a vault it has never heard of by name is not found, and an unfollowed one is not searched", async () => {
    expect((await handle(r, APP, chat, "exit", "steady")).keyboard).toBeUndefined();
  });
});

describe("/panic", () => {
  test("offers Disarm all and an Exit button for each followed vault, and no other", async () => {
    await r.follow(chat, V1);
    await r.follow(chat, V2);
    await r.follow(chat + 1, "0x00000000000000000000000000000000000000c3");
    const out = await handle(r, APP, chat, "panic", "");
    expect(out.text).toBe(PANIC_TEXT);
    expect(buttons(out.keyboard)).toEqual([
      { text: DISARM_BUTTON, url: `${APP}#disarm-all` },
      { text: "Exit Steady USDG", url: `${APP}#exit=${V1}` },
      { text: "Exit Steady Stocks", url: `${APP}#exit=${V2}` },
    ]);
  });
  test("with no followed vaults it still offers Disarm all and says why there is no Exit button", async () => {
    const out = await handle(r, APP, chat, "panic", "");
    expect(out.text).toContain(PANIC_NO_VAULTS);
    expect(buttons(out.keyboard)).toEqual([{ text: DISARM_BUTTON, url: `${APP}#disarm-all` }]);
  });
  test("a followed vault with no card is labelled by a short address", async () => {
    await r.follow(chat, "0x00000000000000000000000000000000000000c3");
    expect(buttons((await handle(r, APP, chat, "panic", "")).keyboard)[1]!.text).toBe("Exit 0x0000…00c3");
  });
});

describe("bot wording", () => {
  test("never holds keys or signs, and passes the banned-words gate", async () => {
    await r.follow(chat, V1);
    const texts = [PANIC_TEXT, PANIC_NO_VAULTS, EXIT_HINT, (await handle(r, APP, chat, "exit", V1)).text, alarmAlert({ vaultName: "V", alarm: "a price alarm" })];
    for (const t of texts) expect(findBanned(t)).toEqual([]);
    expect(PANIC_TEXT).toContain("Canopy never signs for you and never holds your keys");
  });
  test("no button carries a wallet address or an amount", async () => {
    await r.follow(chat, V1);
    const all = [...buttons(alertKeyboard(APP, V1)), ...buttons((await handle(r, APP, chat, "panic", "")).keyboard)];
    for (const b of all) expect(b.url).toMatch(/#(exit|risk)=0x[0-9a-f]{40}$|#disarm-all$/);
  });
});
