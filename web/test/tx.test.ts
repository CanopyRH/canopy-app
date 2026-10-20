import { expect, test } from "bun:test";
import { decodeFunctionData, keccak256, maxUint256, parseAbi, stringToHex, type Address } from "viem";
import { COPY, TERMS } from "../src/copy/text";
import { CONFIG } from "../src/config";
import deployment from "../src/deployment.json";
import { alarmBookAbi, approveTx, armTx, disarmAllTx, exitTx, isBlocked, parseWallet, planTx, PLAN_AMOUNTS, registerTx, routerAbi, termsHash, ZERO_KEY } from "../src/tx";
import { registrationOrder } from "../../services/src/api/presets";
import sanctioned from "../src/sanctioned.json";
import { findBanned } from "../../tools/banned-words";
import { extractAddresses } from "../../tools/update-sanctions";
import { alarmBookAbi as compiledBook, routerAbi as compiled } from "../../services/src/chain/abi.generated";

const R = "0x00000000000000000000000000000000000000a1" as Address;
const A = "0x00000000000000000000000000000000000000a2" as Address;
const V = "0x00000000000000000000000000000000000000a3" as Address;
const K = `0x${"22".repeat(32)}` as const;

test("arm records the exact terms hash and takes no swap in v1", () => {
  const { args } = decodeFunctionData({ abi: routerAbi, data: armTx(R, A, V, [K]).data });
  const p = (args as readonly [{ adapter: Address; target: Address; harbour: number; maxSlipBps: number; termsHash: string; keys: readonly string[] }])[0];
  expect(p.adapter.toLowerCase()).toBe(A);
  expect(p.target.toLowerCase()).toBe(V);
  expect(p.harbour).toBe(0);
  expect(p.maxSlipBps).toBe(0);
  expect(p.termsHash).toBe(keccak256(stringToHex(TERMS)));
  expect(p.keys).toEqual([K]);
});

test("the web ABI matches the compiled router selectors", () => {
  const names = ["arm", "exit", "disarmAll", "positionId"] as const;
  for (const n of names) {
    const types = (abi: readonly unknown[]) =>
      (abi.find((x) => (x as { type: string; name?: string }).type === "function" && (x as { name: string }).name === n) as { inputs: { type: string }[] }).inputs.map((i) => i.type);
    expect(types(routerAbi)).toEqual(types(compiled));
  }
});

test("the web register call matches the compiled AlarmBook", () => {
  const types = (abi: readonly unknown[]) =>
    JSON.stringify((abi.find((x) => (x as { name?: string }).name === "register") as { inputs: { type: string; components?: { type: string }[] }[] }).inputs[0]!.components!.map((c) => c.type));
  expect(types(alarmBookAbi)).toBe(types(compiledBook));
  const d = registrationOrder(V)[0]!;
  expect(registerTx(R, d).to).toBe(R);
});
