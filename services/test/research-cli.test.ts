import { expect, test } from "bun:test";
import { researchCommand } from "../src/research-cli";
test("CLI rejects unknown commands and injected transport or signing arguments", async () => {
  for (const input of [
    { command: "trade" },
    { command: "funding", privateKey: "x" },
    { command: "funding", query: { rpcUrl: "https://invalid.test" } },
  ])
    await expect(researchCommand(input)).rejects.toThrow();
});
test("CLI compares offline reports without credentials or RPC", async () => {
  const r = {
    version: 1,
    feature: "controls",
    chainId: 4663,
    observedAt: { block: "1", hash: "a" },
    data: { vault: "0x12", value: "1" },
    limitations: [],
  };
  const out = (await researchCommand({
    command: "changes",
    before: r,
    after: { ...r, data: { ...r.data, value: "2" } },
  })) as any;
  expect(out.data.changes).toEqual([
    { path: "/data/value", before: "1", after: "2" },
  ]);
});
