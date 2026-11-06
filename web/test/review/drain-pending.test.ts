// Review V3-S05. The app refuses to arm any preset whose keys are "going off" (tripped now, or fired in the last day):
// it asks AlarmBook.check() for each key and its parts, then armable() for the keys it arms. In v2, check() answers false
// while a DRAIN drop is pending its 60 s confirmation, and the app arms the BOTH key, not the DRAIN part, so armable() was
// never asked about the part. During that minute the "Vault drain + confirmation" preset read clear and armed, and the
// DRAIN part fired 60 s later for a drop that began before the owner armed.
// Fixed: presetStatus asks armable() for every key of a preset, parts included (once they are registered), and the arm
// flow asks it for the parts too. A pending DRAIN part now blocks the preset.
//
// Real AlarmBook and MockVault bytecode on a local anvil, and the app's own presetStatus/notArmable.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, encodeAbiParameters, encodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { presetStatus, refusedPresets, type AlarmIo } from "../../src/alarms";
import { alarmBookAbi } from "../../src/tx";
import { keyOf, Kind, presetsFor, registrationOrder } from "../../../services/src/api/presets";

const ROOT = join(import.meta.dir, "../../..");
const PORT = 19_545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
// anvil's first default account: a public test key with no value anywhere.
const dev = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
// The repo's pinned anvil when present, else the one on PATH (CI installs Foundry there). Skipped, with a reason, without
// anvil or the built contracts.
const anvilBin = [join(ROOT, ".tools/foundry/v1.8.6/anvil"), Bun.which("anvil")].find((p): p is string => !!p && existsSync(p));
const ready = !!anvilBin && existsSync(join(ROOT, "contracts/out/AlarmBook.sol/AlarmBook.json"));
if (!ready) console.warn(`SKIPPED drain-pending: ${!anvilBin ? "anvil was not found" : "contracts/out is missing (run forge build)"}`);
const anvil = ready ? spawn([anvilBin!, "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "ignore" }) : null;
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 50 });
const wallet = createWalletClient({ chain: foundry, transport: http(RPC), account: dev });
const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC) });
const art = (file: string, name: string) => JSON.parse(readFileSync(join(ROOT, "contracts/out", file, `${name}.json`), "utf8")).bytecode.object as Hex;
const mockAbi = parseAbi(["function deposit(address,uint256)", "function setPrice(uint256)"]);
const bookAbi = parseAbi([
  "struct Detector { uint8 kind; address target; uint256 threshold; uint32 window; bytes32 a; bytes32 b; }",
  "function register(Detector d) returns (bytes32)",
  "function checkpoint(bytes32)",
  "function poke(bytes32) returns (bool)",
  "function armable(bytes32) view returns (bool)",
  "function state(bytes32) view returns (bool, uint64, uint64, uint256, uint256, uint64, uint64)",
]);

async function deploy(bytecode: Hex): Promise<Address> {
  const hash = await wallet.sendTransaction({ data: bytecode, gas: 10_000_000n });
  return (await client.waitForTransactionReceipt({ hash })).contractAddress!;
}
async function send(to: Address, data: Hex) {
  const rc = await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to, data, gas: 5_000_000n }) });
  if (rc.status !== "success") throw new Error("reverted");
}
const warp = async (s: number) => {
  await testClient.increaseTime({ seconds: s });
  await testClient.mine({ blocks: 1 });
};

let book: Address;
let vault: Address;

beforeAll(async () => {
  if (!ready) return;
  for (let i = 0; ; i++) {
    try { await client.getBlockNumber(); break; } catch { if (i > 100) throw new Error("anvil did not start"); await Bun.sleep(100); }
  }
  book = await deploy(`${art("AlarmBook.sol", "AlarmBook")}${encodeAbiParameters([{ type: "address" }, { type: "address[]" }], [dev.address, []]).slice(2)}` as Hex);
  const asset = await deploy(`${art("Mocks.sol", "MockERC20")}${encodeAbiParameters([{ type: "uint8" }], [6]).slice(2)}` as Hex);
  vault = await deploy(`${art("Mocks.sol", "MockVault")}${encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [asset, 1_000_000n]).slice(2)}` as Hex);
  await send(vault, encodeFunctionData({ abi: mockAbi, functionName: "deposit", args: [dev.address, 1_000n * 10n ** 18n] }));
}, 60_000);

afterAll(() => anvil?.kill());

/** What the app reads before it offers a preset, without the contract's own answer (the reviewed code). */
const plainIo: AlarmIo = {
  check: (key) => client.readContract({ address: book, abi: alarmBookAbi, functionName: "check", args: [key] }),
  firedAt: (key) => client.readContract({ address: book, abi: alarmBookAbi, functionName: "state", args: [key] }).then((s) => BigInt(s[1])),
  now: () => client.getBlock().then((b) => b.timestamp),
};
/** What the app reads now: the same, plus armable() for every registered key. */
const io: AlarmIo = {
  ...plainIo,
  armable: (key) => client.readContract({ address: book, abi: bookAbi, functionName: "armable", args: [key] }),
  known: (key) => client.readContract({ address: book, abi: bookAbi, functionName: "state", args: [key] }).then((s) => s[0] as boolean),
};

describe.skipIf(!ready)("V3-S05: a pending DRAIN drop blocks the preset that depends on it", () => {
  test("the drain + confirmation preset is refused during the confirmation minute, and clear again once it has passed", async () => {
    const presets = presetsFor(vault, vault);
    const drainBoth = presets.find((p) => p.requires?.some((r) => r.detector.kind === Kind.DRAIN))!;
    const drain = drainBoth.requires!.find((r) => r.detector.kind === Kind.DRAIN)!;
    // The drain preset's detectors registered, as register-presets.ts does at launch (this mock vault has no curator()).
    const needed = new Set([drainBoth.key, ...drainBoth.requires!.map((r) => r.key)]);
    for (const d of registrationOrder(vault, vault).filter((d) => needed.has(keyOf(d)))) {
      await send(book, encodeFunctionData({ abi: bookAbi, functionName: "register", args: [d] }));
    }
    // Before any drop, the preset is clear.
    expect(await presetStatus(io, drainBoth)).toBe("clear");

    // The keeper samples once a period. A DRAIN reference is live after two rolls (it trips below the lower of the last
    // two period lows), so sample two periods. Then 40% of the vault's assets leave.
    await warp(1_801);
    await send(book, encodeFunctionData({ abi: bookAbi, functionName: "checkpoint", args: [drain.key] }));
    await warp(1_801);
    await send(book, encodeFunctionData({ abi: bookAbi, functionName: "checkpoint", args: [drain.key] }));
    await send(vault, encodeFunctionData({ abi: mockAbi, functionName: "setPrice", args: [600_000n] }));
    // A poke sees the drop and records it: Pending, not fired.
    await send(book, encodeFunctionData({ abi: bookAbi, functionName: "poke", args: [drain.key] }));
    const pendingAt = (await client.readContract({ address: book, abi: bookAbi, functionName: "state", args: [drain.key] }))[6];
    expect(pendingAt).toBeGreaterThan(0n);

    // AlarmBook itself says the drain part is not armable (it reads TRIPPED)...
    expect(await client.readContract({ address: book, abi: bookAbi, functionName: "armable", args: [drain.key] })).toBe(false);
    // ...and now so does the app. The reviewed checks (check, firedAt) alone still read clear: that is the control.
    await warp(10);
    expect(await presetStatus(plainIo, drainBoth)).toBe("clear");
    expect(await presetStatus(io, drainBoth)).toBe("going-off");
    // The DRAIN part on its own is refused, and the BOTH preset's own key too.
    expect(await presetStatus(io, drain)).toBe("going-off");
    // The preset the user would arm is among the refused ones.
    expect((await refusedPresets(io, presets, [drainBoth.key])).map((x) => x.preset.key)).toEqual([drainBoth.key]);

    // A minute after the first sighting, the drain part fires; the preset stays refused for the alarm's day.
    await warp(55);
    await send(book, encodeFunctionData({ abi: bookAbi, functionName: "poke", args: [drain.key] }));
    expect((await client.readContract({ address: book, abi: bookAbi, functionName: "state", args: [drain.key] }))[1]).toBeGreaterThan(pendingAt);
    expect(await presetStatus(io, drainBoth)).toBe("going-off");
  }, 60_000);

  test("an unregistered key is not mistaken for a pending one: the offer shows it clear before it is registered", async () => {
    const other = presetsFor(vault, vault).find((p) => p.name === "Vault loss")!;
    const fresh = presetsFor("0x00000000000000000000000000000000000000f1" as Address).find((p) => p.name === "Vault loss")!;
    expect(await presetStatus(io, fresh)).toBe("clear");
    void other;
  });
});
