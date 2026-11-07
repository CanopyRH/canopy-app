import { test, expect } from "bun:test";
import { keccak256 } from "viem";
import { prepareIdentity } from "../src/agents/erc8004";
const owner = "0x0000000000000000000000000000000000000001",
  registry = "0x0000000000000000000000000000000000000002";
const raw = {
  chainId: 4663,
  registry,
  codeHash: keccak256("0x6000"),
  owner,
  registration: {
    name: "Canopy test agent",
    description: "Keyless position inspection",
    image: "https://example.org/image.png",
    services: [],
    active: false,
  },
};
function fixture() {
  let changed = false,
    other = false;
  const calls: any[] = [];
  return {
    calls,
    change: () => (changed = true),
    other: () => (other = true),
    client: {
      getChainId: async () => 4663,
      getBlock: async () => ({
        number: 123n,
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
      }),
      getCode: async () => (changed ? "0x6001" : "0x6000"),
      getStorageAt: async () => `0x${"0".repeat(64)}`,
      readContract: async () => (other ? registry : owner),
      simulateContract: async (p: any) => {
        calls.push(p);
        return { result: 1n };
      },
    } as never,
  };
}
test("identity preparation is unsigned, simulated and asserts no trust or billing capability", async () => {
  const f = fixture(),
    r = await prepareIdentity(f.client, raw);
  expect(r.metadata).toMatchObject({
    x402Support: false,
    supportedTrust: [],
    registrations: [],
  });
  expect(r.transaction).toMatchObject({ from: owner, to: registry, value: 0n });
  expect(f.calls[0]).toMatchObject({
    functionName: "register",
    blockNumber: 123n,
    account: owner,
  });
});
test("identity code changes and another owner fail before simulation", async () => {
  const f = fixture();
  f.change();
  await expect(prepareIdentity(f.client, raw)).rejects.toThrow("code");
  expect(f.calls).toHaveLength(0);
  const g = fixture();
  g.other();
  await expect(
    prepareIdentity(g.client, { ...raw, agentId: "1" }),
  ).rejects.toThrow("another owner");
  expect(g.calls).toHaveLength(0);
});
