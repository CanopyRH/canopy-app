// Your own alarm levels, in the browser: 0.5%, 1%, 2%, 5% or 10% for the "Vault loss" alarm.
// The app keeps every rule it had: a key that is tripped, fired in the last 24 hours or can't be read is never offered,
// keys are worked out here and never fetched, and a DRAIN window stays at or above 1,200 seconds.
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { type AlarmIo, REFIRE_SECONDS, refusedPresets } from "../src/alarms";
import { network } from "../src/chain";
import { CONFIG } from "../src/config";
import { COPY } from "../src/copy/text";
import { LEVEL_COPY } from "../src/copy/levels";
import { armableFor, chosenLevel, levelViews, registrationFor, withLevel } from "../src/levels";
import { alarmBookAbi, MIN_DRAIN_WINDOW, registerTx } from "../src/tx";
import { levelDetector, levelLabel, levelPreset, LEVELS_BPS } from "../../services/src/api/levels";
import { keyOf, Kind, presetsFor, registrationOrder } from "../../services/src/api/presets";

const V = "0x00000000000000000000000000000000000000a3" as Address;
const BOOK = "0x00000000000000000000000000000000000000a1" as Address;
const NOW = 2_000_000_000n;
const key = (bps: number) => levelPreset(V, bps as never).key;
const lossKey = presetsFor(V).find((p) => p.name === "Vault loss")!.key;
const quorumKey = presetsFor(V).find((p) => p.name === "Exploit confirmed")!.key;

const book = (tripped: Hex[] = [], fired: Record<Hex, bigint> = {}): AlarmIo => ({
  check: async (k) => tripped.includes(k),
  firedAt: async (k) => fired[k] ?? 0n,
  now: async () => NOW,
});

describe("what the picker offers", () => {
  test("five levels, smallest first, each read as a percentage", async () => {
    const views = await levelViews(book(), V);
    expect(views.map((v) => levelLabel(v.bps))).toEqual(["0.5%", "1%", "2%", "5%", "10%"]);
    expect(views.every((v) => v.status === "clear")).toBe(true);
  });

  test("a level that is tripped now is going off, and the others stay clear", async () => {
    const views = await levelViews(book([key(200)]), V);
    expect(views.map((v) => v.status)).toEqual(["clear", "clear", "going-off", "clear", "clear"]);
  });

  test("a level that fired in the last 24 hours is going off even though check() is false; after that it is clear", async () => {
    const recent = await levelViews(book([], { [key(100)]: NOW - 3_600n }), V);
    expect(recent.find((v) => v.bps === 100)!.status).toBe("going-off");
    const edge = await levelViews(book([], { [key(100)]: NOW - REFIRE_SECONDS }), V);
    expect(edge.find((v) => v.bps === 100)!.status).toBe("going-off");
    const old = await levelViews(book([], { [key(100)]: NOW - REFIRE_SECONDS - 1n }), V);
    expect(old.find((v) => v.bps === 100)!.status).toBe("clear");
  });

  test("a level that can't be read is unreadable, never clear, whichever read fails", async () => {
    const fail = async () => { throw new Error("rpc down"); };
    for (const io of [{ ...book(), check: fail }, { ...book(), firedAt: fail }, { ...book(), now: fail }] as AlarmIo[]) {
      expect((await levelViews(io, V)).every((v) => v.status === "unreadable")).toBe(true);
    }
  });

  test("an unreadable level doesn't hide the clear ones, and a refused level can't be armed", async () => {
    const io: AlarmIo = { ...book(), check: async (k) => { if (k === key(500)) throw new Error("rpc"); return k === key(50); } };
    const views = await levelViews(io, V);
    expect(views.map((v) => v.status)).toEqual(["going-off", "clear", "clear", "unreadable", "clear"]);
    const refused = await refusedPresets(io, armableFor(V, presetsFor(V)), [key(50), key(100), key(500)]);
    expect(refused.map((r) => [r.preset.name, r.status])).toEqual([["Vault loss", "going-off"], ["Vault loss at 5%", "unreadable"]]);
  });
});

describe("choosing a level", () => {
  test("choosing a level adds its key, and choosing another swaps it, so a vault holds one loss level", () => {
    let picked: Hex[] = [];
    picked = withLevel(V, picked, 200);
    expect(picked).toEqual([key(200)]);
    picked = withLevel(V, picked, 1000);
    expect(picked).toEqual([key(1000)]);
    expect(chosenLevel(V, picked)).toBe(1000);
  });

  test("other alarms stay where they are, and choosing none removes only the level", () => {
    const picked = withLevel(V, [quorumKey, key(50)], 500);
    expect(picked).toEqual([quorumKey, key(500)]);
    expect(withLevel(V, picked, null)).toEqual([quorumKey]);
    expect(chosenLevel(V, [quorumKey])).toBeNull();
  });

  test("the 0.5% level is the Vault loss alarm already on the list, so both show the same choice", () => {
    expect(key(50)).toBe(lossKey);
    expect(chosenLevel(V, [lossKey])).toBe(50);
    expect(withLevel(V, [lossKey], 100)).toEqual([key(100)]);
  });

  test("arming everything the app offers never needs more than the 8 keys a position may hold", () => {
    const all = presetsFor(V).map((p) => p.key);
    expect(withLevel(V, all, 1000).length).toBeLessThanOrEqual(8);
  });
});

describe("keys are worked out here", () => {
  test("no server is asked: the keys come out the same with the network cut off", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("the key must not come from a server"); }) as never;
    try {
      expect((await levelViews(book(), V)).map((v) => v.preset.key)).toEqual(LEVELS_BPS.map(key));
      expect(registrationFor(V, registrationOrder(V))).not.toHaveLength(0);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("each key is the hash of its detector, and only the five listed thresholds can be built", () => {
    for (const bps of LEVELS_BPS) expect(key(bps)).toBe(keyOf(levelDetector(V, bps)));
    expect(() => levelDetector(V, 75)).toThrow();
  });

  test("a key that isn't one of the app's alarms is refused before the wallet is asked anything", async () => {
    const off = keyOf({ ...levelDetector(V, 100), threshold: 150n });
    const signer = { provider: {} as never, account: "0x00000000000000000000000000000000000000f1" as Address, onConfirm: () => { throw new Error("the wallet was asked"); } };
    await expect(network(CONFIG).arm(signer, V, [off])).rejects.toThrow(COPY.armRefused);
    await expect(network(CONFIG).arm(signer, V, [quorumKey, off])).rejects.toThrow(COPY.armRefused);
  });
});

describe("registering the levels", () => {
  const all = registrationFor(V, registrationOrder(V));

  test("every level is registered once, the presets' detectors keep their order, and the 0.5% level is not doubled", () => {
    const keys = all.map(keyOf);
    expect(new Set(keys).size).toBe(keys.length);
    for (const bps of LEVELS_BPS) expect(keys).toContain(key(bps));
    expect(keys.slice(0, registrationOrder(V).length)).toEqual(registrationOrder(V).map(keyOf));
  });

  test("a level registers with the call the preset's own alarms use, and the call carries the exact detector", () => {
    for (const bps of LEVELS_BPS) {
      const tx = registerTx(BOOK, levelDetector(V, bps));
      const { functionName, args } = decodeFunctionData({ abi: alarmBookAbi, data: tx.data });
      expect(tx.to).toBe(BOOK);
      expect(functionName).toBe("register");
      expect(keyOf(args![0] as never)).toBe(key(bps));
    }
  });

  test("every DRAIN the app registers still has a window of 1,200 seconds or more, and a shorter one is still refused", () => {
    const drains = all.filter((d) => d.kind === Kind.DRAIN);
    expect(drains.length).toBeGreaterThan(0);
    for (const d of drains) {
      expect(d.window).toBeGreaterThanOrEqual(MIN_DRAIN_WINDOW);
      expect(registerTx(BOOK, d).to).toBe(BOOK);
      expect(() => registerTx(BOOK, { ...d, window: MIN_DRAIN_WINDOW - 1 })).toThrow(/at least 1200 seconds/);
    }
    expect(all.filter((d) => d.kind === Kind.SHARE_DROP).every((d) => d.window === 0)).toBe(true);
  });
});

describe("the words", () => {
  test("the trade-off is one plain line that says both sides", () => {
    expect(LEVEL_COPY.tradeoff).toContain("smaller level exits you sooner");
    expect(LEVEL_COPY.tradeoff).toContain("bigger level waits for a bigger loss");
    expect(LEVEL_COPY.tradeoff).not.toContain("\n");
  });

  test("each level's note names its percentage", () => {
    for (const bps of LEVELS_BPS) expect(LEVEL_COPY.note(levelLabel(bps))).toContain(levelLabel(bps));
  });
});
