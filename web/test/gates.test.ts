import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { exitBlocked, type Read } from "../src/gates";

const V = "0x00000000000000000000000000000000000000a1" as Address;
const OWNER = "0x00000000000000000000000000000000000000a2" as Address;
const ADAPTER = "0x00000000000000000000000000000000000000a3" as Address;
const ROUTER = "0x00000000000000000000000000000000000000a4" as Address;
const GATE = "0x00000000000000000000000000000000000000a5" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";

/** A vault with one gate set, whose contract answers `allowed` for each address. */
const vault = (gate: string, allowed: (who: Address) => boolean): Read => async (address, fn, args) => {
  if (address === V) return fn === gate ? GATE : ZERO;
  return allowed(args![0] as Address);
};

describe("gates at arming", () => {
  test("a Vault V1, with no gate functions, is not blocked", async () => {
    const read: Read = async () => { throw new Error("no such function"); };
    expect(await exitBlocked(read, V, OWNER, ADAPTER, ROUTER)).toBe(false);
  });

  test("a vault where only some gates can be read counts as blocked", async () => {
    const read: Read = async (_, fn) => {
      if (fn === "sendSharesGate") throw new Error("rpc failed");
      return fn.startsWith("can") ? true : ZERO;
    };
    expect(await exitBlocked(read, V, OWNER, ADAPTER, ROUTER)).toBe(true);
  });

  test("a V2 vault with no gates set is not blocked", async () => {
    expect(await exitBlocked(async () => ZERO, V, OWNER, ADAPTER, ROUTER)).toBe(false);
  });

  test("a gate that lets every part of the exit through is not blocked", async () => {
    expect(await exitBlocked(vault("sendSharesGate", () => true), V, OWNER, ADAPTER, ROUTER)).toBe(false);
  });

  test("a receive gate that refuses the adapter blocks the exit, like the live OUSD vault", async () => {
    expect(await exitBlocked(vault("receiveSharesGate", (w) => w !== ADAPTER), V, OWNER, ADAPTER, ROUTER)).toBe(true);
  });

  test("a send gate has to pass both the owner and the adapter", async () => {
    expect(await exitBlocked(vault("sendSharesGate", (w) => w !== OWNER), V, OWNER, ADAPTER, ROUTER)).toBe(true);
    expect(await exitBlocked(vault("sendSharesGate", (w) => w !== ADAPTER), V, OWNER, ADAPTER, ROUTER)).toBe(true);
  });

  test("an asset gate has to pass the router", async () => {
    expect(await exitBlocked(vault("receiveAssetsGate", (w) => w !== ROUTER), V, OWNER, ADAPTER, ROUTER)).toBe(true);
  });

  test("a gate that can't be read counts as blocked", async () => {
    const read: Read = async (address, fn) => {
      if (address === V) return fn === "receiveSharesGate" ? GATE : ZERO;
      throw new Error("reverted");
    };
    expect(await exitBlocked(read, V, OWNER, ADAPTER, ROUTER)).toBe(true);
  });
});
