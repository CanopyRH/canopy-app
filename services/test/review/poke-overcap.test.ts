// Review V3-S03. AlarmBook v2 gives every target read a full 1M gas, but the keeper refuses any poke whose simulation uses
// more than SMALL_CALL_GAS (1M). A poke the keeper refuses throws "poke reverts or needs too much gas in simulation" and is
// counted as poke_fail, and nothing else happens: the key is not quarantined and its miss count doesn't grow. So a key
// whose target reads as tripped but makes the poke cost a little over 1M (here a SHARE_DROP vault whose convertToAssets
// spends 950k gas and then answers a low price) is checked and simulated again on every one-second pass, forever. That
// is the A2-M3 outcome ("a key that reads tripped but never fires is poked every second") reached another way, and the
// keeper's poke loop is sequential, so every such key adds a simulation round trip in front of honest keys.
// The poke itself would land with the keeper's own READ_GAS_FLOOR of 1.6M: the 1M cap and the 1.6M floor disagree.
//
// Real AlarmBook bytecode on a local anvil, the keeper's real pokeTripped and gasFor, and the test database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "bun";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { alarmBookAbi } from "../../src/chain/abi";
import { keyOf, Kind } from "../../src/api/presets";
import { pokeTripped, READ_GAS_FLOOR, SMALL_CALL_GAS, type KeeperDeps } from "../../src/keeper/keeper";
import { repo } from "../../src/store/repo";
import { freshDb } from "../db";

const ROOT = join(import.meta.dir, "../../..");
const PORT = 18_545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
// anvil's first default account: a public test key with no value anywhere.
const dev = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OWNER = "0xabababababababababababababababababababab";

const HEAVY = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
contract HeavyVault {
    uint256 public price = 1e18;
    function setPrice(uint256 p) external { price = p; }
    function decimals() external pure returns (uint8) { return 18; }
    function convertToAssets(uint256) external view returns (uint256) {
        uint256 stop = gasleft() - 950_000;
        while (gasleft() > stop) {}
        return price;
    }
}`;

function compile(): Hex {
  const dir = mkdtempSync(join(tmpdir(), "heavy-"));
  writeFileSync(join(dir, "Heavy.sol"), HEAVY);
  const out = spawnSync([join(ROOT, ".tools/solc/solc-0.8.28"), "--bin", "--optimize", join(dir, "Heavy.sol")]);
  const bin = /Binary:\s*\n([0-9a-f]+)/.exec(out.stdout.toString())?.[1];
  if (!bin) throw new Error(out.stderr.toString());
  return `0x${bin}`;
}

const anvil = spawn([join(ROOT, ".tools/foundry/v1.8.6/anvil"), "--port", String(PORT), "--silent", "--gas-limit", "100000000"], { stdout: "ignore", stderr: "ignore" });
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 50 });
const wallet = createWalletClient({ chain: foundry, transport: http(RPC), account: dev });

async function deploy(bytecode: Hex): Promise<Address> {
  const hash = await wallet.sendTransaction({ data: bytecode, gas: 10_000_000n });
  return (await client.waitForTransactionReceipt({ hash })).contractAddress!;
}
async function send(to: Address, data: Hex, gas = 5_000_000n) {
  const hash = await wallet.sendTransaction({ to, data, gas });
  const rc = await client.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error("reverted");
  return rc;
}

let book: Address;
let heavy: Address;
let key: Hex;

beforeAll(async () => {
  for (let i = 0; ; i++) {
    try { await client.getBlockNumber(); break; } catch { if (i > 100) throw new Error("anvil did not start"); await Bun.sleep(100); }
  }
  const art = JSON.parse(readFileSync(join(ROOT, "contracts/out/AlarmBook.sol/AlarmBook.json"), "utf8"));
  const args = encodeAbiParameters([{ type: "address" }, { type: "address[]" }], [dev.address, []]);
  book = await deploy(`${art.bytecode.object}${args.slice(2)}` as Hex);
  heavy = await deploy(compile());
  const det = { kind: Kind.SHARE_DROP, target: heavy, threshold: 50n, window: 0, a: `0x${"00".repeat(32)}` as Hex, b: `0x${"00".repeat(32)}` as Hex };
  key = keyOf(det);
  await send(book, encodeFunctionData({ abi: alarmBookAbi, functionName: "register", args: [det] }));
  // The share price falls 10%: the key reads tripped.
  await send(heavy, encodeFunctionData({ abi: parseAbi(["function setPrice(uint256)"]), functionName: "setPrice", args: [9n * 10n ** 17n] }));
}, 60_000);

afterAll(() => anvil.kill());

describe("V3-S03: a key whose poke needs a little over 1M gas is simulated every pass and never set aside", () => {
  test("on chain: check() reads tripped, the poke costs more than SMALL_CALL_GAS and lands under READ_GAS_FLOOR", async () => {
    const check = await client.readContract({ address: book, abi: alarmBookAbi, functionName: "check", args: [key], gas: 5_000_000n } as never);
    expect(check).toBe(true);
    const est = await client.estimateGas({ account: dev.address, to: book, data: encodeFunctionData({ abi: alarmBookAbi, functionName: "poke", args: [key] }) });
    console.log(`poke estimate ${est} gas; keeper cap ${SMALL_CALL_GAS}, keeper floor ${READ_GAS_FLOOR}`);
    expect(est).toBeGreaterThan(SMALL_CALL_GAS);
    expect(est).toBeLessThan(READ_GAS_FLOOR);
  });

  test("the keeper: every pass checks and simulates the key, sends nothing, and never quarantines it", async () => {
    const db = await freshDb();
    const r = repo(db);
    await r.setPaidUntil(OWNER, 4_000_000_000);
    await r.upsertPosition({ posId: `0x${"01".repeat(32)}`, owner: OWNER, adapter: book, target: heavy.toLowerCase(), tokenId: 0n, harbour: 0, maxSlipBps: 0, epoch: 0n, block: 1n, termsHash: "t", keys: [key] });
    let sims = 0;
    let sends = 0;
    const quarantine = new Map<string, number>();
    const misses = new Map<string, number>();
    let now = Math.floor(Date.now() / 1000);
    const d = {
      client: { ...client, call: client.call, readContract: client.readContract, simulateCalls: async (a: never) => { sims++; return client.simulateCalls(a); } },
      repo: r, router: book, alarmBook: book, multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11", morpho: book, account: dev.address,
      send: async () => { sends++; return `0x${"00".repeat(32)}` as Hex; },
      now: () => now, paidOnly: true, quarantine, misses,
    } as unknown as KeeperDeps;
    // anvil has no Multicall3, so every shared request fails and each key is checked on its own: the same answers.
    const passes = 5;
    for (let i = 0; i < passes; i++) {
      expect(await pokeTripped(d)).toEqual([]);
      now += 1;
    }
    expect(sims).toBe(passes); // one simulation per pass, every pass
    expect(sends).toBe(0);
    expect(quarantine.has(key.toLowerCase())).toBe(false);
    expect(misses.size).toBe(0);
    expect((await r.health(now)).counters.poke_fail).toBe(String(passes));
  });
});
