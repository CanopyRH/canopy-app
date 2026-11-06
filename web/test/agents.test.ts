import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { approveTx, armTx, disarmAllTx, exitTx } from "../src/tx";
import { TERMS } from "../src/copy/text";
import { TERMS as SERVICES_TERMS } from "../../services/src/api/terms";
import { approveCall, armCall, disarmAllCall, exitCall, termsHash } from "../../services/src/api/calldata";
import { ROUTES as SPEC_ROUTES } from "../../services/src/api/spec";
// @ts-expect-error plain JS module
import { API, EXAMPLES, NOT_FOR_AGENTS, ROUTES, RULES } from "../src/site/agentsContent.js";
import mainnet from "../src/mainnet.json";

const here = (p: string) => join(import.meta.dir, "..", p);
const ROUTER = "0x1c3ca2b2f01c30b731909563dad550062b340757" as Address;
const ADAPTER = "0x32c39abf03a12303cc3150be50ed7b0e03ab9d38" as Address;
const VAULT = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd" as Address;
const KEYS = ["0x" + "11".repeat(32), "0x" + "22".repeat(32)] as Hex[];
const POS = ("0x" + "33".repeat(32)) as Hex;

describe("API calldata is what the app builds", () => {
  test("arm, approve, exit and disarmAll are byte for byte the app's transactions", () => {
    expect(armCall(ROUTER, ADAPTER, VAULT, KEYS).data).toBe(armTx(ROUTER, ADAPTER, VAULT, KEYS).data);
    expect(approveCall(VAULT, ROUTER).data).toBe(approveTx(VAULT, ROUTER).data);
    expect(exitCall(ROUTER, POS).data).toBe(exitTx(ROUTER, POS).data);
    expect(disarmAllCall(ROUTER).data).toBe(disarmAllTx(ROUTER).data);
    expect(armCall(ROUTER, ADAPTER, VAULT, KEYS).to.toLowerCase()).toBe(armTx(ROUTER, ADAPTER, VAULT, KEYS).to.toLowerCase());
  });

  test("the services' copy of the terms is the app's, so the recorded hash is the same", () => {
    expect(SERVICES_TERMS).toBe(TERMS);
    expect(termsHash()).toBe(keccak256(stringToHex(TERMS)));
  });
});

describe("agents page", () => {
  test("the page, its html and the static llms.txt exist and are wired", () => {
    const html = readFileSync(here("public/agents.html"), "utf8");
    expect(html).toContain('data-page="agents"');
    expect(readFileSync(here("src/site/pages/agents.jsx"), "utf8")).toContain("export default function Agents");
    expect(readFileSync(here("public/llms.txt"), "utf8")).toContain("# Canopy");
  });

  test("the base URL is the one the app uses", () => {
    expect(API).toBe(mainnet.apiUrl);
  });

  test("it lists every public API route", () => {
    const listed = new Set(ROUTES.map((r: { path: string }) => r.path.split("?")[0]));
    for (const r of SPEC_ROUTES) expect(listed.has(r.path.replace(/:(\w+)/g, (_m, n) => (n === "target" ? "{vault}" : `{${n}}`)))).toBe(true);
  });

  test("it states the hard rules, and tells builders never to grant disarm rights", () => {
    const text = [...RULES.map((r: { title: string; body: string }) => `${r.title}. ${r.body}`), NOT_FOR_AGENTS].join("\n");
    expect(text).toContain("No recipient field");
    expect(text).toContain("Exit Now and Disarm All are free");
    expect(text).toContain("Agents can arm and tighten");
    expect(text).toContain("Only owners loosen or disarm");
    expect(text).toContain("Never give an agent the right to disarm");
    expect(text).toContain("No external audit yet");
    expect(readFileSync(here("src/site/pages/agents.jsx"), "utf8")).toContain("Never give an agent disarm rights.");
  });

  test("the examples cover presets, arm, exit and the log, and name no real wallet", () => {
    const code = EXAMPLES.map((e: { code: string }) => e.code).join("\n");
    for (const part of ["/presets/", "/calldata/arm", "/calldata/exit", "/alarms/live", "/exits"]) expect(code).toContain(part);
    expect(code).not.toMatch(/recipient|receiver/i);
    expect(code).not.toMatch(/\/Users\//);
  });

  test("the page and its brief use none of the banned wording", async () => {
    const { findBanned } = await import("../../tools/banned-words");
    const all = [JSON.stringify(RULES), JSON.stringify(EXAMPLES), JSON.stringify(ROUTES), NOT_FOR_AGENTS, readFileSync(here("src/site/pages/agents.jsx"), "utf8"), readFileSync(here("public/llms.txt"), "utf8")].join("\n");
    expect(findBanned(all)).toEqual([]);
  });
});
