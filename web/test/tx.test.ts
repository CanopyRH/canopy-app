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

test("exit has no recipient and uses the owner path", () => {
  const { functionName, args } = decodeFunctionData({ abi: routerAbi, data: exitTx(R, K).data });
  expect(functionName).toBe("exit");
  expect(args).toEqual([K, ZERO_KEY, 0n]);
  const exit = compiled.find((x) => x.type === "function" && x.name === "exit") as unknown as { inputs: { name: string }[] };
  expect(exit.inputs.map((i) => i.name)).toEqual(["posId", "alarmKey", "amount"]);
});

test("approve only ever names the router", () => {
  const erc = parseAbi(["function approve(address,uint256)"]);
  const { args } = decodeFunctionData({ abi: erc, data: approveTx(V, R).data });
  expect((args[0] as string).toLowerCase()).toBe(R);
  expect(args[1]).toBe(maxUint256);
});

test("plan amounts match the priced plans", () => {
  expect(PLAN_AMOUNTS.months3).toBe(15_000_000n);
  expect(PLAN_AMOUNTS.year).toBe(60_000_000n);
  expect(planTx(V, R, PLAN_AMOUNTS.year).to).toBe(V);
  expect(disarmAllTx(R).to).toBe(R);
});

test("sanctioned addresses are blocked, ordinary ones are not", () => {
  expect(sanctioned.addresses.length).toBeGreaterThan(100);
  expect(isBlocked(sanctioned.addresses[0]!.toUpperCase().replace("0X", "0x"))).toBe(true);
  expect(isBlocked(R)).toBe(false);
});

test("the OFAC parser reads digital currency entries only", () => {
  const xml = `<id><idType>Digital Currency Address - ETH</idType>
    <idNumber>0xAbC0000000000000000000000000000000000001</idNumber></id>
    <id><idType>Passport</idType><idNumber>0xdef0000000000000000000000000000000000002</idNumber></id>`;
  expect(extractAddresses(xml)).toEqual(["0xabc0000000000000000000000000000000000001"]);
});

test("wallet input is validated", () => {
  expect(parseWallet("nope")).toBeNull();
  expect(parseWallet(`  ${R} `)?.toLowerCase()).toBe(R);
});

test("copy is clean and terms are not promises", () => {
  expect(findBanned(JSON.stringify(COPY))).toEqual([]);
  expect(TERMS).toContain("does not pay for losses");
  expect(TERMS.length).toBeGreaterThan(50);
  expect(termsHash()).toMatch(/^0x[0-9a-f]{64}$/);
});

test("the release build holds no test deployment", () => {
  expect(CONFIG.chainId).toBe(4663);
  expect(deployment).toEqual({});
  expect(CONFIG.vaults.length).toBeGreaterThanOrEqual(5);
});
