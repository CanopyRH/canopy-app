import { expect, test } from "bun:test";
import { createObservatory, heartbeatTyped } from "../src/index";
const vault = "0x" + "12".repeat(20);
test("SDK research uses an operator URL, exact query values and credential-free requests", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const sdk = createObservatory({
    apiUrl: "https://api.example.test",
    fetcher: (async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        version: 1,
        feature: "liquidity",
        chainId: 4663,
        observedAt: { block: "1" },
        data: { amount: "999999999999999999999999" },
        limitations: [],
      });
    }) as typeof fetch,
  });
  expect((await sdk.liquidity(vault, vault)).data.amount).toBe(
    "999999999999999999999999",
  );
  expect(new URL(calls[0]!.url).searchParams.get("owner")).toBe(vault);
  expect(calls[0]!.init?.credentials).toBe("omit");
  expect(calls[0]!.init?.redirect).toBe("error");
});
test("SDK local tools never use the network and reject incompatible reports", () => {
  const sdk = createObservatory({
    fetcher: (() => {
      throw Error("network called");
    }) as unknown as typeof fetch,
  });
  const report = {
    version: 1,
    feature: "controls",
    chainId: 4663,
    observedAt: { block: "1", hash: "0x01" },
    data: { vault, value: "1" },
    limitations: [],
  };
  expect(
    sdk.changes(report, { ...report, data: { vault, value: "2" } }).data
      .changes,
  ).toHaveLength(1);
  expect(() => sdk.changes(report, { ...report, chainId: 1 })).toThrow();
  expect(typeof heartbeatTyped).toBe("function");
});
