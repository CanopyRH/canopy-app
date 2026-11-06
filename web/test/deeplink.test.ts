import { describe, expect, test } from "bun:test";
import { getAddress, type Address } from "viem";
import { linkStep, parseDeepLink, type LinkContext, type LinkRow } from "../src/deeplink";
import { LINK_COPY } from "../src/copy/exitlink";
import { findBanned } from "../../tools/banned-words";

const A = getAddress("0x00000000000000000000000000000000000000a1");
const B = getAddress("0x00000000000000000000000000000000000000b2");
const VAULTS = [{ address: A, name: "Vault A" }, { address: B, name: "Vault B" }];
const row = (address: Address, armed: boolean | null): LinkRow => ({ vault: { address, name: "x" }, state: armed === null ? null : { armed } });
const ctx = (over: Partial<LinkContext> = {}): LinkContext => ({ live: true, vaults: VAULTS, rows: [], complete: true, connected: true, ...over });

describe("deep-link parsing", () => {
  test("reads the three links", () => {
    expect(parseDeepLink(`#exit=${A}`)).toEqual({ kind: "exit", vault: A });
    expect(parseDeepLink(`#risk=${A}`)).toEqual({ kind: "risk", vault: A });
    expect(parseDeepLink("#disarm-all")).toEqual({ kind: "disarm-all" });
  });
  test("a vault in any letter case comes back as a checksummed address", () => {
    const lower = "0xbeeff033f34c046626b8d0a041844c5d1a5409dd";
    const got = parseDeepLink(`#exit=${lower.toUpperCase().replace("0X", "0x")}`);
    expect(got).toEqual({ kind: "exit", vault: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd" });
  });
  test("a bare wallet or nothing is left to the landing page's hand-over", () => {
    expect(parseDeepLink("")).toBeNull();
    expect(parseDeepLink("#")).toBeNull();
    expect(parseDeepLink(`#${A}`)).toEqual({ kind: "wallet", value: A });
  });
  test("bad input is refused", () => {
    const bad = [
      "#exit", "#exit=", "#exit=0x", `#exit=${A.slice(0, 41)}`, `#exit=${A}00`, `#exit=${A}&amount=5`, `#exit=${A}&wallet=${B}`,
      `#exit=${A} `, `#exit= ${A}`, `#exit=${A}/`, `#exit=${A.replace("0x", "")}`, "#exit=vault", `#exit=0x${"g".repeat(40)}`,
      `#exit=${A},${B}`, "#exit=%ZZ", `#exits=${A}`, `#EXIT=${A}`, "#disarm-all=1", "#disarm-all&x=1", "#disarm", "#disarm-all ", "#disarmall",
      `#risk=${A}&x`, "#risk=", `#exit=${A}#x`, "#exit=0x%00",
    ];
    for (const h of bad) expect(parseDeepLink(h)).toEqual({ kind: "refused" });
  });
  test("an encoded link is read the same way", () => {
    expect(parseDeepLink(`#exit%3D${A}`)).toEqual({ kind: "exit", vault: A });
    expect(parseDeepLink(`#exit%3D${A}%26amount%3D5`)).toEqual({ kind: "refused" });
  });
});

describe("what the app opens for a link", () => {
  const exit = parseDeepLink(`#exit=${A}`);
  test("no link, or a wallet link, opens nothing", () => {
    expect(linkStep(null, ctx())).toEqual({ step: "none" });
    expect(linkStep(parseDeepLink(`#${A}`), ctx())).toEqual({ step: "none" });
  });
  test("a refused link says so", () => {
    expect(linkStep(parseDeepLink("#exit=nope"), ctx())).toEqual({ step: "refused" });
  });
  test("an exit link waits for a wallet, then for its positions", () => {
    expect(linkStep(exit, ctx({ connected: false, rows: null }))).toEqual({ step: "connect", vault: "Vault A" });
    expect(linkStep(exit, ctx({ rows: null }))).toEqual({ step: "reading" });
  });
  test("an exit link opens the Exit Now confirmation for that vault only, and only for an armed position", () => {
    expect(linkStep(exit, ctx({ rows: [row(B, true), row(A, true)] }))).toEqual({ step: "exit", vault: A, name: "Vault A" });
    expect(linkStep(parseDeepLink(`#exit=${B}`), ctx({ rows: [row(A, true), row(B, true)] }))).toEqual({ step: "exit", vault: B, name: "Vault B" });
  });
  test("a wallet with no position there is told so plainly", () => {
    expect(linkStep(exit, ctx({ rows: [row(B, true)] }))).toEqual({ step: "no-position", vault: "Vault A" });
    expect(linkStep(exit, ctx({ rows: [] }))).toEqual({ step: "no-position", vault: "Vault A" });
  });
  test("a position that isn't armed has no Canopy exit to confirm", () => {
    expect(linkStep(exit, ctx({ rows: [row(A, false)] }))).toEqual({ step: "not-armed", vault: "Vault A" });
    expect(linkStep(exit, ctx({ rows: [row(A, null)] }))).toEqual({ step: "not-armed", vault: "Vault A" });
  });
  test("an incomplete read never claims there is no position", () => {
    expect(linkStep(exit, ctx({ rows: [], complete: false }))).toEqual({ step: "unreadable" });
  });
  test("a vault Canopy does not list is refused even when well formed", () => {
    const other = parseDeepLink(`#exit=0x${"c".repeat(40)}`);
    expect(linkStep(other, ctx())).toEqual({ step: "unknown-vault" });
    expect(linkStep(parseDeepLink(`#risk=0x${"c".repeat(40)}`), ctx())).toEqual({ step: "unknown-vault" });
  });
  test("with no contracts set, nothing to sign is offered", () => {
    expect(linkStep(exit, ctx({ live: false, rows: [row(A, true)] }))).toEqual({ step: "not-live" });
    expect(linkStep(parseDeepLink("#disarm-all"), ctx({ live: false }))).toEqual({ step: "not-live" });
  });
  test("disarm all opens its confirmation once a wallet is connected", () => {
    const d = parseDeepLink("#disarm-all");
    expect(linkStep(d, ctx({ connected: false, rows: null }))).toEqual({ step: "connect" });
    expect(linkStep(d, ctx({ rows: null }))).toEqual({ step: "disarm" });
  });
  test("a risk link shows the card with no wallet", () => {
    expect(linkStep(parseDeepLink(`#risk=${A}`), ctx({ connected: false, rows: null }))).toEqual({ step: "risk", vault: A, name: "Vault A" });
  });
});

describe("link wording", () => {
  const all = [LINK_COPY.refused, LINK_COPY.disarmConnect, LINK_COPY.exitConnect("V"), LINK_COPY.unknownVault, LINK_COPY.noPosition("V"), LINK_COPY.notArmed("V"), LINK_COPY.exitTitle("V"), LINK_COPY.exitBody, LINK_COPY.disarmBody];
  test("passes the banned-words gate", () => {
    for (const t of all) expect(findBanned(t)).toEqual([]);
  });
  test("says the person signs and Canopy never does", () => {
    expect(LINK_COPY.exitBody).toContain("Canopy never signs for you");
    expect(LINK_COPY.exitConnect("V")).toContain("Canopy never signs for you");
    expect(LINK_COPY.disarmBody).toContain("Canopy never signs for you");
  });
});
