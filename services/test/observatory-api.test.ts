import { expect, test } from "bun:test";
import { createApi } from "../src/api/server";
import plugin from "../src/plugins/observatory";
import { FEATURES, type ResearchProvider } from "../src/observatory";
const vault = "0x0000000000000000000000000000000000000001";
const owner = "0x0000000000000000000000000000000000000002";
function api(research?: ResearchProvider) {
  return createApi({
    db: {} as never,
    repo: {} as never,
    watchers: [],
    alarmBook: vault,
    chainId: 4663,
    now: () => 1000,
    vaults: async () => [],
    liveAlarms: async () => [],
    plugins: [plugin],
    research,
    rateLimit: { perMin: 1000, proxyHops: 0 },
  });
}
const value = {
  version: 1,
  feature: "controls",
  chainId: 4663,
  observedAt: { block: "1" },
  data: {},
  limitations: [],
};
test("catalog names exactly ten usable tools and separates local analyses", async () => {
  const r = await api().request("/research");
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.features).toEqual(FEATURES);
  expect(body.features.filter((f: any) => f.mode === "live")).toHaveLength(6);
  expect(
    (await api().request(`/research/controls?vault=${vault}`)).status,
  ).toBe(503);
  expect((await api().request("/research/heartbeat")).status).toBe(404);
});
test("rejects recipients, duplicate arguments, malformed addresses and account ambiguity before any read", async () => {
  let calls = 0;
  const a = api(async () => {
    calls++;
    return value;
  });
  for (const q of [
    `/research/controls?vault=${vault}&recipient=${owner}`,
    `/research/controls?vault=${vault}&vault=${owner}`,
    "/research/controls?vault=bad",
    `/research/perps?owner=${owner}`,
    "/research/perps?account=1",
    `/research/perps?owner=${owner}&account=281474976710656`,
    "/research/funding?apiUrl=https://attacker.invalid",
  ])
    expect((await a.request(q)).status).toBe(400);
  expect(calls).toBe(0);
});
test("caches only public observations; owner requests are neither cached nor publicly cacheable", async () => {
  let calls = 0;
  const a = api(async () => {
    calls++;
    return value;
  });
  for (let i = 0; i < 2; i++)
    expect((await a.request(`/research/controls?vault=${vault}`)).status).toBe(
      200,
    );
  expect(calls).toBe(1);
  for (let i = 0; i < 2; i++) {
    const r = await a.request(
      `/research/liquidity?vault=${vault}&owner=${owner}`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  }
  expect(calls).toBe(3);
});
test("limits expensive concurrent readers and releases slots after settlement", async () => {
  const releases: (() => void)[] = [];
  const a = api(async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return value;
  });
  const first = a.request(`/research/controls?vault=${vault}`),
    second = a.request(`/research/liquidity?vault=${vault}&owner=${owner}`);
  await new Promise((r) => setTimeout(r, 10));
  const busy = await a.request("/research/funding");
  expect(busy.status).toBe(503);
  expect(busy.headers.get("retry-after")).toBe("5");
  releases.forEach((r) => r());
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
});
test("provider diagnostics cannot leak credentials into public errors", async () => {
  const r = await api(async () => {
    throw new Error("https://provider.invalid/secret-token");
  }).request("/research/funding");
  expect(r.status).toBe(502);
  expect(await r.text()).not.toContain("secret-token");
});
