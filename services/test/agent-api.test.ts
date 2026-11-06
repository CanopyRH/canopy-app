import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, keccak256, stringToHex, type Address, type Hex } from "viem";
import { createApi } from "../src/api/server";
import { routerAbi, erc20Abi } from "../src/chain/abi";
import { keyOf, presetsFor } from "../src/api/presets";
import { INTERNAL_ROUTES, ROUTES, buildOpenApi, routeKey } from "../src/api/spec";
import { buildLlmsTxt } from "../src/api/llms";
import { termsHash, type CalldataChain, type ChainReads } from "../src/api/calldata";
import { PLUGINS } from "../src/plugins";
import { repo } from "../src/store/repo";
import { freshDb } from "./db";

const ROUTER = "0x1c3ca2b2f01c30b731909563dad550062b340757" as Address;
const ADAPTER = "0x32c39abf03a12303cc3150be50ed7b0e03ab9d38" as Address;
const BOOK = "0x6a391f2c489ddfcb60ad64edddda5ea0921584cf" as Address;
const VAULT = "0x00000000000000000000000000000000000000a1" as Address;
const OWNER = "0x00000000000000000000000000000000000000b2" as Address;
const POS = ("0x" + "77".repeat(32)) as Hex;

const [LOSS, QUORUM] = presetsFor(VAULT).map((p) => p.key);
const UNKNOWN = ("0x" + "ee".repeat(32)) as Hex;
const FIRED = ("0x" + "dd".repeat(32)) as Hex;

function reads(over: Partial<ChainReads> = {}): ChainReads {
  return {
    keyState: async (k) => (k === UNKNOWN ? { known: false, armable: false } : k === FIRED ? { known: true, armable: false } : { known: true, armable: true }),
    positionId: async () => POS,
    isArmed: async () => true,
    ...over,
  };
}
const chain = (over: Partial<ChainReads> = {}): CalldataChain => ({ chainId: 4663, router: ROUTER, adapter: ADAPTER, alarmBook: BOOK, reads: reads(over) });

async function setup(o: { calldata?: CalldataChain | null; perMin?: number } = {}) {
  const db = await freshDb();
  const calldata = o.calldata === null ? undefined : (o.calldata ?? chain());
  const app = createApi({
    db, repo: repo(db), vaults: async () => [], liveAlarms: async () => [], watchers: [], alarmBook: BOOK, chainId: 4663, now: () => 0,
    calldata, publicUrl: "https://api.example.test", appUrl: "https://site.example.test", rateLimit: { perMin: o.perMin ?? 1000, proxyHops: 0 },
  });
  const get = async (path: string) => {
    const res = await app.request(path);
    const text = await res.text();
    return { res, text, json: () => JSON.parse(text) as any };
  };
  return { app, get };
}

describe("OpenAPI spec", () => {
  test("every route the app has is in the spec or named as internal, and nothing in the spec is missing from the app", async () => {
    const { app } = await setup();
    const real = new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => routeKey(r.method, r.path)));
    const specced = new Set(ROUTES.map((r) => routeKey(r.method, r.path)));
    const internal = new Set(INTERNAL_ROUTES.map((r) => routeKey(r.method, r.path)));
    const undocumented = [...real].filter((k) => !specced.has(k) && !internal.has(k));
    expect(undocumented).toEqual([]);
    expect([...specced].filter((k) => !real.has(k))).toEqual([]);
    expect([...internal].filter((k) => !real.has(k))).toEqual([]);
    for (const k of specced) expect(internal.has(k)).toBe(false);
  });

  test("every shipped plugin route is covered too", async () => {
    expect(PLUGINS.map((p) => p.name)).toContain("agent");
    expect(PLUGINS.map((p) => p.name)).toContain("exits");
  });

  test("GET /openapi.json is an OpenAPI 3.1 document with every route, parameter, limit and error", async () => {
    const { get } = await setup({ perMin: 90 });
    const { res, json } = await get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const spec = json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers).toEqual([{ url: "https://api.example.test" }]);
    expect(Object.keys(spec.paths).sort()).toEqual([...new Set(ROUTES.map((r) => r.path.replace(/:(\w+)/g, "{$1}")))].sort());
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      const op = item.get;
      const named = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(op.parameters?.filter((p: any) => p.in === "path").map((p: any) => p.name) ?? []).toEqual(named);
      expect(op.responses["200"]).toBeDefined();
      expect(op.responses["429"].headers["Retry-After"]).toBeDefined();
      expect(op["x-rate-limit"]).toEqual({ requests: 90, windowSeconds: 60, per: "client address (IPv6 counted by /64)" });
    }
    expect(spec.paths["/calldata/arm"].get.responses["422"]).toBeDefined();
    expect(spec.paths["/exits"].get.parameters.map((p: any) => p.name)).toEqual(["limit", "before"]);
    expect(JSON.stringify(spec)).not.toContain("$ref");
    expect(buildOpenApi({ baseUrl: "x", perMin: 1 }).info.description).toContain("external audit");
  });

  test("the spec names no recipient parameter anywhere", () => {
    const spec = JSON.stringify(buildOpenApi({ baseUrl: "x", perMin: 1 }));
    expect(spec).not.toMatch(/"name":"(recipient|receiver|to|payee)"/i);
  });

  test("real answers match the schemas in the spec", async () => {
    const { get } = await setup();
    const check = async (path: string, specPath: string, status = 200) => {
      const { res, json } = await get(path);
      expect(res.status).toBe(status);
      const def = ROUTES.find((r) => r.path === specPath)!;
      const schema = status === 200 ? def.ok.schema! : def.errors!.find((e) => e.status === status)!.schema!;
      expect(() => schema.parse(json())).not.toThrow();
    };
    await check("/vaults", "/vaults");
    await check("/exits", "/exits");
    await check(`/presets/${VAULT}`, "/presets/:target");
    await check(`/calldata/arm?vault=${VAULT}&keys=${LOSS}`, "/calldata/arm");
    await check(`/calldata/arm?vault=${VAULT}&keys=${UNKNOWN}`, "/calldata/arm", 422);
    await check(`/calldata/exit?vault=${VAULT}&owner=${OWNER}`, "/calldata/exit");
    await check("/calldata/disarm-all", "/calldata/disarm-all");
    await check(`/risk/${VAULT}`, "/risk/:target", 404);
  });
});

describe("calldata", () => {
  test("arm: returns approve and arm that decode to v2's tuple with no swaps and the app's terms hash", async () => {
    const { get } = await setup();
    const { res, json } = await get(`/calldata/arm?vault=${VAULT}&keys=${LOSS},${QUORUM}`);
    expect(res.status).toBe(200);
    const body = json();
    expect(body.chainId).toBe(4663);
    expect(body.calls.map((c: any) => c.step)).toEqual(["approve", "arm"]);

    const [approve, arm] = body.calls;
    expect(approve.to.toLowerCase()).toBe(VAULT);
    const a = decodeFunctionData({ abi: erc20Abi, data: approve.data });
    expect(a.functionName).toBe("approve");
    expect((a.args[0] as string).toLowerCase()).toBe(ROUTER);
    expect(a.args[1]).toBe(2n ** 256n - 1n);

    expect(arm.to.toLowerCase()).toBe(ROUTER);
    expect(arm.value).toBe("0");
    const d = decodeFunctionData({ abi: routerAbi, data: arm.data });
    expect(d.functionName).toBe("arm");
    const p = (d.args as unknown as any[])[0];
    expect(p.adapter.toLowerCase()).toBe(ADAPTER);
    expect(p.target.toLowerCase()).toBe(VAULT);
    expect(p.tokenId).toBe(0n);
    expect(p.harbour).toBe(0);
    expect(p.maxSlipBps).toBe(0);
    expect(p.swaps).toEqual([]);
    expect([...p.keys]).toEqual([LOSS, QUORUM]);
    expect(p.termsHash).toBe(termsHash());
  });

  test("arm: keys are lower-cased, de-duplicated and kept in order", async () => {
    const { get } = await setup();
    const upper = "0x" + LOSS!.slice(2).toUpperCase();
    const { res, json } = await get(`/calldata/arm?vault=${VAULT}&keys=${QUORUM},${upper},${LOSS}`);
    expect(res.status).toBe(200);
    expect(json().keys).toEqual([QUORUM, LOSS]);
  });

  test("arm: refuses a key that is not registered, and one that is not armable, naming each", async () => {
    const { get } = await setup();
    const { res, json } = await get(`/calldata/arm?vault=${VAULT}&keys=${LOSS},${UNKNOWN},${FIRED}`);
    expect(res.status).toBe(422);
    const body = json();
    expect(body.code).toBe("keys_refused");
    expect(body.calls).toBeUndefined();
    expect(body.keys).toEqual([
      { key: UNKNOWN, reason: "not_registered" },
      { key: FIRED, reason: "not_armable" },
    ]);
  });

  test("arm: a chain that cannot be read is a 502, not a guess", async () => {
    const { get } = await setup({ calldata: chain({ keyState: async () => { throw new Error("rpc down"); } }) });
    const { res, json } = await get(`/calldata/arm?vault=${VAULT}&keys=${LOSS}`);
    expect(res.status).toBe(502);
    expect(json().code).toBe("chain_unavailable");
  });

  test("arm: bad input is a 400", async () => {
    const { get } = await setup();
    for (const q of [
      "", `?vault=${VAULT}`, `?keys=${LOSS}`, `?vault=nope&keys=${LOSS}`, `?vault=${VAULT}&keys=0x12`,
      `?vault=${VAULT}&keys=${LOSS},`, `?vault=${VAULT}&keys=${Array.from({ length: 9 }, (_, i) => "0x" + i.toString(16).padStart(64, "0")).join(",")}`,
      `?vault=${VAULT}&vault=${VAULT}&keys=${LOSS}`,
    ]) expect((await get(`/calldata/arm${q}`)).res.status).toBe(400);
  });

  test("exit: decodes to exit(posId, 0, 0) for the owner's armed position", async () => {
    const asked: unknown[] = [];
    const { get } = await setup({ calldata: chain({ positionId: async (o, v) => (asked.push([o, v]), POS) }) });
    const { res, json } = await get(`/calldata/exit?vault=${VAULT}&owner=${OWNER}`);
    expect(res.status).toBe(200);
    const body = json();
    expect(body.positionId).toBe(POS);
    expect((asked[0] as string[]).map((a) => a.toLowerCase())).toEqual([OWNER, VAULT]);
    const [call] = body.calls;
    expect(call.to.toLowerCase()).toBe(ROUTER);
    const d = decodeFunctionData({ abi: routerAbi, data: call.data });
    expect(d.functionName).toBe("exit");
    expect(d.args as unknown).toEqual([POS, "0x" + "00".repeat(32), 0n]);
  });

  test("exit: an owner with no armed position gets a 404 that points at the vault", async () => {
    const { get } = await setup({ calldata: chain({ isArmed: async () => false }) });
    const { res, json } = await get(`/calldata/exit?vault=${VAULT}&owner=${OWNER}`);
    expect(res.status).toBe(404);
    expect(json().code).toBe("not_armed");
  });

  test("exit: bad addresses are a 400", async () => {
    const { get } = await setup();
    expect((await get(`/calldata/exit?vault=${VAULT}&owner=0x12`)).res.status).toBe(400);
    expect((await get(`/calldata/exit?vault=${VAULT}`)).res.status).toBe(400);
  });

  test("disarm-all: decodes to disarmAll() with no arguments", async () => {
    const { get } = await setup();
    const { res, json } = await get("/calldata/disarm-all");
    expect(res.status).toBe(200);
    const [call] = json().calls;
    expect(call.to.toLowerCase()).toBe(ROUTER);
    const d = decodeFunctionData({ abi: routerAbi, data: call.data });
    expect(d.functionName).toBe("disarmAll");
    expect(call.data.length).toBe(10);
  });

  test("no calldata route accepts a recipient, in any spelling", async () => {
    const { get } = await setup();
    for (const name of ["recipient", "receiver", "to", "payee", "destination", "beneficiary"]) {
      for (const path of [`/calldata/arm?vault=${VAULT}&keys=${LOSS}`, `/calldata/exit?vault=${VAULT}&owner=${OWNER}`, "/calldata/disarm-all"]) {
        const sep = path.includes("?") ? "&" : "?";
        const { res, json } = await get(`${path}${sep}${name}=${OWNER}`);
        expect(res.status).toBe(400);
        expect(json().code).toBe("no_recipient");
      }
    }
    const { res, json } = await get("/calldata/disarm-all?foo=1");
    expect(res.status).toBe(400);
    expect(json().code).toBe("unknown_parameter");
  });

  test("a deployment without contracts answers 503 on every calldata route", async () => {
    const { get } = await setup({ calldata: null });
    for (const p of [`/calldata/arm?vault=${VAULT}&keys=${LOSS}`, `/calldata/exit?vault=${VAULT}&owner=${OWNER}`, "/calldata/disarm-all"]) {
      const { res, json } = await get(p);
      expect(res.status).toBe(503);
      expect(json().code).toBe("no_contracts");
    }
  });

  test("calldata routes share the read limit", async () => {
    const { app } = await setup({ perMin: 2 });
    const hit = () => app.request("/calldata/disarm-all", { headers: { "x-forwarded-for": "198.51.100.7" } });
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    const limited = await hit();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("the terms hash matches the app's terms (the app's copy is the source)", async () => {
    const web = readFileSync(join(import.meta.dir, "../../web/src/copy/text.ts"), "utf8");
    const terms = /export const TERMS = `([^`]*)`/.exec(web)![1]!;
    expect(termsHash()).toBe(keccak256(stringToHex(terms)));
  });

  test("a test key really is one of the vault's presets", () => {
    expect(keyOf(presetsFor(VAULT)[0]!.detector)).toBe(LOSS!);
  });
});

describe("llms.txt", () => {
  const mainnet = JSON.parse(readFileSync(join(import.meta.dir, "../../web/src/mainnet.json"), "utf8")) as Record<string, string>;
  const hardRules = [
    "There is no recipient field",
    "Exit Now and Disarm All are free",
    "Agents can arm and tighten",
    "Only owners loosen",
    "Never give an agent the right to disarm",
    "There is no external audit yet",
  ];

  test("GET /llms.txt states the hard rules, the API address, the contracts and the links", async () => {
    const { get } = await setup();
    const { res, text } = await get("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    for (const r of hardRules) expect(text).toContain(r);
    expect(text).toContain("Base URL: https://api.example.test");
    expect(text).toContain("https://api.example.test/openapi.json");
    expect(text).toContain("https://site.example.test/agents.html");
    expect(text).toContain("chain id 4663");
    for (const a of [ROUTER, ADAPTER, BOOK]) expect(text).toContain(a);
    for (const r of ROUTES.filter((r) => r.path.startsWith("/calldata"))) expect(text).toContain(r.path);
  });

  test("an alerts-only deployment says it has no contracts", async () => {
    const { get } = await setup({ calldata: null });
    const { text } = await get("/llms.txt");
    expect(text).toContain("no Canopy contracts");
    expect(text).not.toContain("ExitRouter:");
  });

  test("web/public/llms.txt is the same brief, with the launch addresses", () => {
    const file = readFileSync(join(import.meta.dir, "../../web/public/llms.txt"), "utf8");
    expect(file).toBe(
      buildLlmsTxt({ apiUrl: mainnet.apiUrl!, chain: { chainId: 4663, router: mainnet.router!, adapter: mainnet.adapter!, alarmBook: mainnet.alarmBook! } }),
    );
    for (const r of hardRules) expect(file).toContain(r);
  });

  test("the brief names no personal identifier and no banned wording", () => {
    const text = buildLlmsTxt({ apiUrl: "https://api.example.test" });
    expect(text).not.toMatch(/\b(apy|apr|yields?|profits?|insured|insurance|guarantee[ds]?)\b/i);
    expect(text).not.toMatch(/\/Users\//);
  });
});
