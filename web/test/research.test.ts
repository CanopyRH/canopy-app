import { expect, test } from "bun:test";
import { readResearch, readResearchFile } from "../src/research";
test("research uses no cookies or referrer and sends only the chosen query", async () => {
  let url = "",
    options: any;
  const data = {
    version: 1,
    feature: "controls",
    chainId: 4663,
    observedAt: { block: "1" },
    data: { vault: "x" },
    limitations: [],
  };
  const out = await readResearch(
    "https://api.example.test",
    "controls",
    { vault: "x", owner: "" },
    undefined,
    (async (u: Parameters<typeof fetch>[0], o?: Parameters<typeof fetch>[1]) => {
      url = String(u);
      options = o;
      return new Response(JSON.stringify(data));
    }) as unknown as typeof fetch,
  );
  expect(out).toEqual(data);
  expect(url).toBe("https://api.example.test/research/controls?vault=x");
  expect(options.credentials).toBe("omit");
  expect(options.referrerPolicy).toBe("no-referrer");
  expect(options.redirect).toBe("error");
});
test("research refuses unexpected features, payloads and oversized responses", async () => {
  await expect(
    readResearch("https://api.example.test", "heartbeat", {}),
  ).rejects.toThrow("live reader");
  for (const body of [
    "not JSON",
    JSON.stringify({ version: 1, feature: "funding" }),
    "x".repeat(2_000_001),
  ])
    await expect(
      readResearch(
        "https://api.example.test",
        "controls",
        {},
        undefined,
        (async () => new Response(body)) as unknown as typeof fetch,
      ),
    ).rejects.toThrow();
});
test("local import refuses oversized files before reading their body", async () => {
  let called = false;
  await expect(
    readResearchFile({
      size: 2_000_001,
      text: async () => {
        called = true;
        return "{}";
      },
    }),
  ).rejects.toThrow();
  expect(called).toBe(false);
  expect(await readResearchFile({ size: 2, text: async () => "{}" })).toEqual(
    {},
  );
});
