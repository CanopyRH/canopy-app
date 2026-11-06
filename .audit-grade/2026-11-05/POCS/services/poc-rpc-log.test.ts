import { expect, test } from "bun:test";
import { createPublicClient, fallback, http } from "viem";
test("RPC errors carry a path-embedded API key into e.message, which index.ts logs", async () => {
  const transport = fallback([http("http://127.0.0.1:9/robinhood/SECRET_PATH_KEY", { retryCount: 0 }), http("http://127.0.0.1:9/backup/SECRET_PATH_KEY", { retryCount: 0 })]);
  const client = createPublicClient({ transport });
  const msg = await client.getBlockNumber().then(() => "", (e) => (e as Error).message);
  console.log(JSON.stringify(msg));
  expect(msg).toContain("SECRET_PATH_KEY");
});
