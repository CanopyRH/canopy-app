import { describe, expect, test } from "bun:test";
import { PREVIEW, VERDICT } from "../src/copy/preview";
import { buildPreview, money, payout, verdict, worstAlarm, type AlarmLine, type PreviewDeps, type VaultIo } from "../src/preview";
import { findBanned } from "../../tools/banned-words";

const M = 1_000_000n;

/** A fake vault: shares are worth 1.5 assets each, and it lets out `maxShares` shares at most. A full redeem works only when everything fits. */
const vault = (maxShares: bigint, over: Partial<VaultIo> = {}): VaultIo => ({
  previewRedeem: async (s) => (s * 3n) / 2n,
  maxRedeem: async () => maxShares,
  maxWithdraw: async () => (maxShares * 3n) / 2n,
  redeemNow: async (s) => (s <= maxShares ? (s * 3n) / 2n : null),
  ...over,
});

const deps = (over: Partial<PreviewDeps> = {}): PreviewDeps => ({
  vault: vault(10n * M),
  allowance: async () => 10n * M,
  blocked: async () => false,
  alarms: async () => [{ name: "Vault loss", status: "clear" }],
  ...over,
});

describe("what the vault would pay", () => {
  test("a vault with room pays the whole position", async () => {
    expect(await payout(vault(10n * M), 4n * M, null)).toEqual({ shares: 4n * M, worth: 6n * M, payNow: 6n * M, liquidity: "full" });
  });

  test("a vault short of cash pays what maxRedeem allows, capped by maxWithdraw", async () => {
    const p = await payout(vault(1n * M), 4n * M, null);
    expect(p.liquidity).toBe("partial");
    expect(p.payNow).toBe(1_500_000n);
    expect(p.worth).toBe(6n * M);
    const capped = await payout(vault(1n * M, { maxWithdraw: async () => 1_000_000n }), 4n * M, null);
    expect(capped.payNow).toBe(1_000_000n);
  });

  test("a vault that reports no limit and refuses the redeem pays nothing", async () => {
    const p = await payout(vault(0n, { redeemNow: async () => null }), 4n * M, null);
    expect(p).toEqual({ shares: 4n * M, worth: 6n * M, payNow: 0n, liquidity: "none" });
  });

  test("a vault whose limit reads fail is treated as paying nothing, not as an error", async () => {
    const boom = async () => {
      throw new Error("no such function");
    };
    const p = await payout(vault(0n, { redeemNow: async () => null, maxRedeem: boom, maxWithdraw: boom }), 4n * M, null);
    expect(p.liquidity).toBe("none");
  });

  test("a vault that reports 0 from maxRedeem but accepts the redeem still pays in full", async () => {
    const p = await payout(vault(0n, { redeemNow: async (s) => (s * 3n) / 2n }), 4n * M, null);
    expect(p.liquidity).toBe("full");
    expect(p.payNow).toBe(6n * M);
  });

  test("an armed position is limited by its approval, not its balance", async () => {
    const p = await payout(vault(10n * M), 4n * M, 1n * M);
    expect(p.shares).toBe(1n * M);
    expect(p.payNow).toBe(1_500_000n);
  });

  test("an armed position with no approval pulls nothing", async () => {
    expect((await payout(vault(10n * M), 4n * M, 0n)).liquidity).toBe("none");
  });

  test("a failed price read throws, so the caller can say it could not read the vault", async () => {
    const bad = vault(10n * M, { previewRedeem: async () => Promise.reject(new Error("rpc")) });
    await expect(payout(bad, 4n * M, null)).rejects.toThrow();
  });
});

describe("the verdict", () => {
  const read = (over: Partial<PreviewDeps> = {}, held = 4n * M, armed = true) => buildPreview(deps(over), held, armed);

  test("a clear, fully payable, armed position says so in one line", async () => {
    const v = verdict(await read(), "USDG");
    expect(v.text).toBe(`${VERDICT.full(money(6n * M, "USDG"))} ${VERDICT.alarmsClear}`);
    expect(v.text).toBe("An exit now would pay you 6.00 USDG. All alarms are clear.");
    expect(v.tone).toBe("good");
  });

  test("a position that is not armed says it is not armed, and reads no allowance", async () => {
    let asked = false;
    const p = await read({ allowance: async () => ((asked = true), 0n) }, 4n * M, false);
    expect(asked).toBe(false);
    expect(verdict(p, "USDG").text).toStartWith("Not armed.");
  });

  test("a partial exit names both amounts", async () => {
    const v = verdict(await read({ vault: vault(1n * M) }), "USDG");
    expect(v.text).toContain("only 1.50 USDG of 6.00 USDG");
    expect(v.tone).toBe("warn");
  });

  test("an alarm that is going off is named, and wins over unreadable", async () => {
    const alarms: AlarmLine[] = [{ name: "a", status: "unreadable" }, { name: "b", status: "going-off" }, { name: "c", status: "clear" }];
    const v = verdict(await read({ alarms: async () => alarms }), "USDG");
    expect(v.text).toEndWith(VERDICT.alarmsGoingOff);
    expect(v.tone).toBe("warn");
    expect(worstAlarm(alarms)).toBe("going-off");
  });

  test("an alarm that can't be read is not called clear", async () => {
    const v = verdict(await read({ alarms: async () => [{ name: "a", status: "unreadable" }] }), "USDG");
    expect(v.text).toEndWith(VERDICT.alarmsUnreadable);
    expect(v.text).not.toContain(VERDICT.alarmsClear);
  });

  test("with no alarms to read, the verdict stays about the money", async () => {
    const v = verdict(await read({ alarms: async () => null }), "USDG");
    expect(v.text).toBe("An exit now would pay you 6.00 USDG.");
    expect(worstAlarm(null)).toBeNull();
    expect(worstAlarm([])).toBeNull();
  });

  test("a vault that can't be read says so and shows no amount", async () => {
    const p = await read({ vault: vault(10n * M, { previewRedeem: async () => Promise.reject(new Error("rpc")) }) });
    expect(p.payout).toBeNull();
    expect(verdict(p, "USDG")).toEqual({ text: VERDICT.unreadable, tone: "bad" });
  });

  test("an armed position whose allowance can't be read is not guessed at", async () => {
    const p = await read({ allowance: async () => Promise.reject(new Error("rpc")) });
    expect(p.payout).toBeNull();
    expect(verdict(p, "USDG").text).toBe(VERDICT.unreadable);
  });

  test("a gate that would block the exit wins over a good-looking amount", async () => {
    const v = verdict(await read({ blocked: async () => true }), "USDG");
    expect(v).toEqual({ text: VERDICT.blocked, tone: "bad" });
  });

  test("a gate check that fails is left out rather than called safe or blocked", async () => {
    const p = await read({ blocked: async () => Promise.reject(new Error("rpc")) });
    expect(p.blocked).toBeNull();
    expect(verdict(p, "USDG").tone).toBe("good");
  });

  test("an armed position the router may not pull from says so", async () => {
    const v = verdict(await read({ allowance: async () => 0n }), "USDG");
    expect(v.text).toBe(VERDICT.noApproval);
  });

  test("an approval that covers part of the balance says how much", async () => {
    const v = verdict(await read({ allowance: async () => 1n * M }), "USDG");
    expect(v.text).toContain("only 25% of your shares");
    expect(v.tone).toBe("warn");
  });

  test("a vault that can pay nothing says the shares stay put", async () => {
    const v = verdict(await read({ vault: vault(0n, { redeemNow: async () => null }) }), "USDG");
    expect(v).toEqual({ text: VERDICT.none, tone: "bad" });
  });
});

test("the preview wording passes the banned-words gate and has no stray whitespace", () => {
  const { full, fullIdle, partial, partialApproval, ...plain } = VERDICT;
  const strings = [...Object.values(PREVIEW), ...Object.values(plain), full("1.00 USDG"), fullIdle("1.00 USDG"), partial("1.00 USDG", "2.00 USDG"), partialApproval(25)];
  for (const s of strings) {
    expect(findBanned(s)).toEqual([]);
    expect(s).toBe(s.trim());
  }
});
