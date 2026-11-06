import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { keyStatus, notArmable, presetStatus, refusedPresets, REFIRE_SECONDS, type AlarmIo } from "../src/alarms";
import { COPY } from "../src/copy/text";
import { MIN_DRAIN_WINDOW, registerTx } from "../src/tx";
import { Kind, presetsFor, registrationOrder } from "../../services/src/api/presets";

const V = "0x00000000000000000000000000000000000000a3" as Address;
const BOOK = "0x00000000000000000000000000000000000000a1" as Address;
const NOW = 2_000_000_000n;
const presets = presetsFor(V, V, { paused: true });
const byName = (n: string) => presets.find((p) => p.name === n)!;

/** A fake AlarmBook: which keys would fire now, and when each last fired. */
const book = (tripped: Hex[] = [], fired: Record<Hex, bigint> = {}): AlarmIo => ({
  check: async (k) => tripped.includes(k),
  firedAt: async (k) => fired[k] ?? 0n,
  now: async () => NOW,
});

describe("a key that is already going off", () => {
  test("a key that never fired and is not tripped is clear", async () => {
    expect(await keyStatus(book(), byName("Vault loss").key)).toBe("clear");
  });

  test("a key that is tripped now is going off, even if it has never been poked", async () => {
    const k = byName("Vault loss").key;
    expect(await keyStatus(book([k]), k)).toBe("going-off");
  });

  test("a key that fired an hour ago is going off, though check() is false while it waits to refire", async () => {
    const k = byName("Vault loss").key;
    expect(await keyStatus(book([], { [k]: NOW - 3_600n }), k)).toBe("going-off");
  });

  test("a key fired in the same second as the arming counts", async () => {
    const k = byName("Paused").key;
    expect(await keyStatus(book([], { [k]: NOW }), k)).toBe("going-off");
  });

  test("the 24 hour line is inclusive, like AlarmBook.isLive", async () => {
    const k = byName("Vault loss").key;
    expect(await keyStatus(book([], { [k]: NOW - REFIRE_SECONDS }), k)).toBe("going-off");
    expect(await keyStatus(book([], { [k]: NOW - REFIRE_SECONDS - 1n }), k)).toBe("clear");
  });

  test("a key that fired long ago and is not tripped is clear", async () => {
    const k = byName("Exploit confirmed").key;
    expect(await keyStatus(book([], { [k]: NOW - 40n * REFIRE_SECONDS }), k)).toBe("clear");
  });

  test("a failed read of any of the three inputs means unreadable, never clear", async () => {
    const k = byName("Vault loss").key;
    const fail = async () => { throw new Error("rpc down"); };
    expect(await keyStatus({ ...book(), check: fail }, k)).toBe("unreadable");
    expect(await keyStatus({ ...book(), firedAt: fail }, k)).toBe("unreadable");
    expect(await keyStatus({ ...book(), now: fail }, k)).toBe("unreadable");
  });
});

describe("presets with parts", () => {
  test("a confirmation preset is going off when its soft part is tripped for good, even if its own key is not", async () => {
    const p = byName("Curator change + confirmation");
    expect(p.requires?.length).toBe(2);
    const soft = p.requires![0]!.key;
    expect(await presetStatus(book([soft]), p)).toBe("going-off");
  });

  test("a confirmation preset is going off when its quorum part fired in the last day", async () => {
    const p = byName("Vault drain + confirmation");
    const quorum = byName("Exploit confirmed").key;
    expect(await presetStatus(book([], { [quorum]: NOW - 60n }), p)).toBe("going-off");
  });

  test("going off outranks unreadable, and unreadable outranks clear", async () => {
    const p = byName("Vault drain + confirmation");
    const [soft, quorum] = [p.requires![0]!.key, p.requires![1]!.key];
    const io: AlarmIo = { ...book([soft]), check: async (k) => { if (k === quorum) throw new Error("rpc"); return k === soft; } };
    expect(await presetStatus(io, p)).toBe("going-off");
    expect(await presetStatus({ ...io, check: async (k) => { if (k === quorum) throw new Error("rpc"); return false; } }, p)).toBe("unreadable");
    expect(await presetStatus(book(), p)).toBe("clear");
  });

  test("the plain Vault loss preset is a bare SHARE_DROP key, which is why a lasting loss blocks it", () => {
    const p = byName("Vault loss");
    expect(p.detector.kind).toBe(Kind.SHARE_DROP);
    expect(p.requires).toBeUndefined();
  });
});

describe("what the app refuses to arm", () => {
  test("after a lasting share price loss, Vault loss is refused and the other alarms still go through", async () => {
    const loss = byName("Vault loss").key;
    const io = book([loss], { [loss]: NOW - 5n * 3_600n });
    const chosen = presets.map((p) => p.key);
    const refused = await refusedPresets(io, presets, chosen);
    expect(refused.map((r) => r.preset.name)).toEqual(["Vault loss"]);
    expect(refused[0]!.status).toBe("going-off");
  });

  test("a curator who changed once refuses the curator preset for good, a month later too", async () => {
    const soft = byName("Curator change + confirmation").requires![0]!.key;
    const io = book([soft], { [soft]: NOW - 30n * REFIRE_SECONDS });
    const refused = await refusedPresets(io, presets, presets.map((p) => p.key));
    expect(refused.map((r) => r.preset.name)).toEqual(["Curator change + confirmation"]);
  });

  test("only the chosen presets are checked", async () => {
    const loss = byName("Vault loss").key;
    expect(await refusedPresets(book([loss]), presets, [byName("Paused").key])).toEqual([]);
  });

  test("when nothing is going off, nothing is refused", async () => {
    expect(await refusedPresets(book(), presets, presets.map((p) => p.key))).toEqual([]);
  });

  test("when the chain can't be read, every chosen alarm is refused", async () => {
    const io: AlarmIo = { check: async () => { throw new Error("rpc"); }, firedAt: async () => 0n, now: async () => NOW };
    const refused = await refusedPresets(io, presets, presets.map((p) => p.key));
    expect(refused.length).toBe(presets.length);
    expect(refused.every((r) => r.status === "unreadable")).toBe(true);
  });

  test("the refusal says the alarm is going off, in plain words, and points at Exit now", () => {
    expect(COPY.armRefused).toContain("already going off");
    expect(COPY.armRefused).toContain("Exit now");
    expect(COPY.alarmTripped).toContain("already going off");
    expect(COPY.alarmExitArmed).toContain("Exit now");
    expect(COPY.alarmExitUnarmed).toContain("withdraw from the vault");
    expect(COPY.armRefused.length).toBeLessThan(160); // wallet.friendly() cuts messages at 160 characters
  });
});

describe("DRAIN windows", () => {
  const drain = (window: number) => ({ ...byName("Vault drain + confirmation").requires![0]!.detector, window });

  test("every DRAIN preset the app registers has a window of at least 1,200 seconds", () => {
    const drains = registrationOrder(V).filter((d) => d.kind === Kind.DRAIN);
    expect(drains.length).toBeGreaterThan(0);
    for (const d of drains) expect(d.window).toBeGreaterThanOrEqual(MIN_DRAIN_WINDOW);
  });

  test("a custom DRAIN window under 1,200 seconds is refused", () => {
    for (const w of [0, 1, 2, 60, 1_199]) expect(() => registerTx(BOOK, drain(w))).toThrow(/at least 1200 seconds/);
  });

  test("a DRAIN window of 1,200 seconds or more is accepted", () => {
    expect(registerTx(BOOK, drain(1_200)).to).toBe(BOOK);
    expect(registerTx(BOOK, drain(3_600)).to).toBe(BOOK);
  });

  test("the window rule does not touch other kinds", () => {
    const quorum = { ...byName("Exploit confirmed").detector, window: 0 };
    expect(registerTx(BOOK, quorum).to).toBe(BOOK);
  });
});
