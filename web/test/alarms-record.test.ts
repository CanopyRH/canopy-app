import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findBanned } from "../../tools/banned-words";
// @ts-expect-error plain JS module
import { outcomeDetail, outcomeLabel, postOnXUrl, recordQuery, reviewLine, tweetText, verdictLabel } from "../src/site/alarmsFormat.js";

const summary = (o: Record<string, unknown> = {}) => ({
  fired: { last7d: 2, last30d: 4, all: 4 },
  alarmsWithExit: 1,
  exits: 2,
  medianSecondsToExit: 40,
  noExit: 1,
  noArmedPositions: 1,
  falseAlarms: { falseAlarm: 1, confirmed: 1, unreviewed: 2 },
  ...o,
});
const row = (o: Record<string, unknown>) => ({ outcome: "exited", open: false, exits: { count: 2, firstAfterSeconds: 40 }, ...o });

describe("alarm record wording", () => {
  test("the tweet is written from the live numbers", () => {
    const t = tweetText(summary());
    expect(t).toBe(
      "Canopy's public alarm record: 4 alarms fired, 1 alarm followed by an exit, typical time to exit 40 s, 1 miss. 1 marked false alarm, 2 not yet reviewed. Hits, misses and false alarms all stay on the list.",
    );
    expect(tweetText(summary({ fired: { last7d: 1, last30d: 1, all: 1 }, medianSecondsToExit: null, noExit: 0 }))).toContain("1 alarm fired, 1 alarm followed by an exit. ");
  });

  test("the zero-state tweet claims nothing", () => {
    for (const s of [null, summary({ fired: { last7d: 0, last30d: 0, all: 0 } })]) {
      const t = tweetText(s);
      expect(t).toContain("No alarms have fired yet");
      expect(t).not.toMatch(/\d/);
    }
  });

  test("a tweet fits with its link, and the link carries both parts", () => {
    const worst = tweetText(summary({ fired: { last7d: 99999, last30d: 99999, all: 99999 }, alarmsWithExit: 99999, noExit: 99999, medianSecondsToExit: 86399, falseAlarms: { falseAlarm: 99999, confirmed: 99999, unreviewed: 99999 } }));
    expect(worst.length + 24).toBeLessThanOrEqual(280);
    const u = new URL(postOnXUrl("Hello & goodbye", "https://example.test/alarms.html"));
    expect(u.origin + u.pathname).toBe("https://x.com/intent/tweet");
    expect(u.searchParams.get("text")).toBe("Hello & goodbye");
    expect(u.searchParams.get("url")).toBe("https://example.test/alarms.html");
  });

  test("outcomes read plainly and a miss is a miss", () => {
    expect(outcomeLabel(row({}))).toEqual({ text: "2 exits followed", tone: "exit" });
    expect(outcomeLabel(row({ exits: { count: 1 } })).text).toBe("1 exit followed");
    expect(outcomeLabel(row({ outcome: "no_exit" }))).toEqual({ text: "No exit", tone: "miss" });
    expect(outcomeLabel(row({ outcome: "no_exit", open: true }))).toEqual({ text: "No exit yet", tone: "open" });
    expect(outcomeLabel(row({ outcome: "no_armed_positions" })).text).toBe("No armed positions");
    expect(outcomeDetail(row({}), "12 USDG came back")).toBe("First exit after 40 s · 12 USDG came back");
    expect(outcomeDetail(row({ exits: { count: 1, firstAfterSeconds: null } }), "")).toBe("Exit time not read yet");
  });

  test("an unreviewed alarm is never shown as confirmed", () => {
    expect(verdictLabel("unreviewed")).toEqual({ text: "Not yet reviewed", tone: "unreviewed" });
    expect(verdictLabel(undefined).tone).toBe("unreviewed");
    expect(verdictLabel("false_alarm").text).toBe("False alarm");
    expect(reviewLine({ falseAlarm: 1, confirmed: 1, unreviewed: 2 })).toBe("1 marked false alarm · 1 confirmed · 2 not yet reviewed");
  });

  test("builds the API query from the filters", () => {
    expect(recordQuery({ limit: 20 })).toBe("limit=20");
    expect(recordQuery({ vault: "0xabc", outcome: "no_exit", before: "5:0x1", limit: 20 })).toBe("limit=20&vault=0xabc&outcome=no_exit&before=5%3A0x1");
  });
});

describe("alarm record copy", () => {
  const files = ["../src/site/alarmsFormat.js", "../src/site/pages/alarms.jsx", "../../services/src/plugins/alarms.ts", "../public/alarms.html"];
  // The gate's words, plus the ones that would make an alarm record sound like a promise.
  const extra = [/\bsafe(ty|ly)?\b/i, /\bprotect(ed|s|ion)?\b/i, /\bsecure[ds]?\b/i];
  test("passes the banned-words gate", () => {
    for (const f of files) {
      const text = readFileSync(join(import.meta.dir, f), "utf8");
      expect([f, findBanned(text), extra.filter((r) => r.test(text)).map(String)]).toEqual([f, [], []]);
    }
  });
});
