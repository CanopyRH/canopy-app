import { describe, expect, test } from "bun:test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { notArmable } from "../src/alarms";
import { armTx, alarmBookAbi, routerAbi } from "../src/tx";
import { presetsFor, registrationOrder } from "../../services/src/api/presets";
import { alarmBookAbi as compiledBook, routerAbi as compiled } from "../../services/src/chain/abi.generated";

const R = "0x00000000000000000000000000000000000000a1" as Address;
const A = "0x00000000000000000000000000000000000000a2" as Address;
const V = "0x00000000000000000000000000000000000000a3" as Address;
const K = `0x${"22".repeat(32)}` as Hex;
const keys = presetsFor(V, V, { paused: true }).map((p) => p.key);

describe("the contract's own armable() answer", () => {
  test("keys it accepts pass, and the ones it turns down are named", async () => {
    const no = new Set([keys[0]!, keys[2]!]);
    expect(await notArmable(async (k) => !no.has(k), keys)).toEqual([keys[0]!, keys[2]!]);
    expect(await notArmable(async () => true, keys)).toEqual([]);
  });

  test("a failed read counts as not armable, never as armable", async () => {
    expect(await notArmable(async () => { throw new Error("rpc down"); }, keys)).toEqual(keys);
  });
});

describe("which presets a vault is offered", () => {
  test("a vault that does not answer paused() gets six detectors to register and no Paused alarm", () => {
    expect(registrationOrder(V)).toHaveLength(6);
    expect(presetsFor(V).map((p) => p.name)).not.toContain("Paused");
  });

  test("a vault that answers paused() gets the Paused alarm too", () => {
    expect(registrationOrder(V, V, { paused: true })).toHaveLength(7);
    expect(presetsFor(V, V, { paused: true }).map((p) => p.name)).toContain("Paused");
  });
});

describe("the v2 arm call", () => {
  test("arm sends the swap list, empty for the raw harbour", () => {
    const { args } = decodeFunctionData({ abi: routerAbi, data: armTx(R, A, V, [K]).data });
    const p = (args as readonly [{ swaps: readonly unknown[]; harbour: number; keys: readonly string[] }])[0];
    expect(p.harbour).toBe(0);
    expect(p.swaps).toEqual([]);
    expect(p.keys).toEqual([K]);
  });

  /** Every input and output of a function, down to tuple components, so a field added to the contract can't slip past a web fragment. */
  const shape = (abi: readonly unknown[], name: string) => {
    const f = abi.find((x) => (x as { type: string; name?: string }).type === "function" && (x as { name: string }).name === name) as { inputs: unknown[]; outputs: unknown[] } | undefined;
    const walk = (ps: unknown[]): unknown => (ps as { type: string; components?: unknown[] }[]).map((p) => (p.components ? { type: p.type, components: walk(p.components) } : p.type));
    return f ? { inputs: walk(f.inputs), outputs: walk(f.outputs) } : undefined;
  };

  test("every router and AlarmBook function the web app calls has exactly the compiled shape", () => {
    for (const n of ["arm", "exit", "disarmAll", "positionId", "isArmed"]) {
      expect(shape(compiled, n)).toBeDefined();
      expect(shape(routerAbi, n)).toEqual(shape(compiled, n));
    }
    for (const n of ["register", "state", "check", "armable", "isLive"]) {
      expect(shape(compiledBook, n)).toBeDefined();
      expect(shape(alarmBookAbi, n)).toEqual(shape(compiledBook, n));
    }
  });

  test("the arm struct has the swap legs last, as the router decodes them", () => {
    const inputs = shape(compiled, "arm")!.inputs as { components: unknown[] }[];
    const comps = inputs[0]!.components;
    expect(comps).toHaveLength(8);
    expect(comps[7]).toEqual({ type: "tuple[]", components: ["address", "address", "uint32", "uint8", "bytes"] });
  });
});
