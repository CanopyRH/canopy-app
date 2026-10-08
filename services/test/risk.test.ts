import { expect, test } from "bun:test";
import { cardText, type CardNumbers } from "../src/risk/card";
import { findBanned } from "../../tools/banned-words";

const base: CardNumbers = {
  vault: "0x00000000000000000000000000000000000000c3", name: "Test Vault", assetSymbol: "USDC", assetDecimals: 6,
  totalAssets: "118800000000000", version: "v2", owner: "0x00000000000000000000000000000000000000a1", curator: null, idleAssets: "5000000000",
  gates: [{ name: "sendSharesGate", address: "0x0000000000000000000000000000000000000000", abdicated: true }, { name: "receiveSharesGate", address: "0x0000000000000000000000000000000000000000", abdicated: true }],
  forceDeallocatePenaltyZero: true,
};

test("card states facts, with an unknown curator shown as unknown", () => {
  const t = cardText(base);
  expect(t).toContain("about 118,800,000 USDC");
  expect(t).toContain("curator unknown");
  expect(t).toContain("permanently given up setting them");
  expect(findBanned(t)).toEqual([]);
});

test("a gate that was not given up, or could not be read, gets a warning", () => {
  for (const abdicated of [false, null]) {
    const t = cardText({ ...base, gates: [{ name: "sendSharesGate", address: null, abdicated }] });
    expect(t).toContain("sendSharesGate could still be turned on");
  }
});

test("a gate that is on gets a warning, even if the curator gave up changing it", () => {
  const gate = "0x00000000000000000000000000000000000000d4" as const;
  for (const abdicated of [true, false]) {
    const t = cardText({ ...base, gates: [{ name: "receiveSharesGate", address: gate, abdicated }] });
    expect(t).toContain("receiveSharesGate is on now");
    expect(t).not.toContain("permanently");
    expect(t).not.toContain("could still be turned on");
    expect(findBanned(t)).toEqual([]);
  }
});

test("gates that are on and gates that could be turned on are both reported", () => {
  const gate = "0x00000000000000000000000000000000000000d4" as const;
  const t = cardText({ ...base, gates: [{ name: "receiveSharesGate", address: gate, abdicated: true }, { name: "sendSharesGate", address: null, abdicated: false }] });
  expect(t).toContain("receiveSharesGate is on now");
  expect(t).toContain("sendSharesGate could still be turned on");
});

test("a failed read is shown as unknown, never as safe", () => {
  const t = cardText({ ...base, totalAssets: null, gates: [{ name: "sendSharesGate", address: null, abdicated: true }] });
  expect(t).toContain("Total held: unknown");
  expect(t).not.toContain("permanently");
  expect(t).toContain("sendSharesGate could still be turned on");
});
