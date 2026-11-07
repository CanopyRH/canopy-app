import { expect, test } from "bun:test";
import type { Address } from "viem";
import { findBanned } from "../../tools/banned-words";
import { WHALES_COPY } from "../src/copy/whales";
import { ago, fetchWhales, pct } from "../src/app/whales/whales";

const V = "0x00000000000000000000000000000000000000c3" as Address;
const move = { vault: V, vaultName: "Steakhouse USDG", direction: "out", asset: "USDG", usd: 1_200_000, label: "$1.2M", pctOfVault: 4.1, liquidUsd: 3_000_000, wallet: "0x1234…5678", tx: `0x${"ab".repeat(32)}`, txUrl: "https://robinhoodchain.blockscout.com/tx/0xab", at: 1_000 };
const reply = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

test("asks the API for the one vault and a short page, and sends nothing else", async () => {
  let url = "";
  const f = (async (u: string) => { url = u; return { ok: true, json: async () => [move] }; }) as unknown as typeof fetch;
  expect(await fetchWhales(V, 5, "https://api.example", f)).toEqual([move] as never);
  expect(url).toBe(`https://api.example/whales?vault=${V}&limit=5`);
});

test("a failed or odd answer is null, and malformed rows are dropped", async () => {
  expect(await fetchWhales(V, 5, "", reply([], false))).toBeNull();
  expect(await fetchWhales(V, 5, "", reply({ error: "x" }))).toBeNull();
  expect(await fetchWhales(V, 5, "", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
  expect(await fetchWhales(V, 5, "", reply([move, { direction: "sideways" }, null]))).toEqual([move] as never);
  expect(await fetchWhales(V, 5, "", reply([]))).toEqual([]);
});

test("percent and age read the way a person says them", () => {
  expect(pct(4.1)).toBe("4.1%");
  expect(pct(0.04)).toBe("<0.1%");
  expect(pct(100)).toBe("100%");
  expect(ago(1_000, 1_030)).toBe("just now");
  expect(ago(1_000, 1_000 + 12 * 60)).toBe("12m ago");
  expect(ago(1_000, 1_000 + 3 * 3_600)).toBe("3h ago");
  expect(ago(1_000, 1_000 + 3 * 86_400)).toBe("3d ago");
});

test("the panel's words pass the banned-words gate and carry the pitch", () => {
  expect(findBanned(Object.values(WHALES_COPY).join("\n"))).toEqual([]);
  expect(WHALES_COPY.pitch).toBe("Know when whales run before you do.");
});
