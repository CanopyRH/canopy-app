// The keeper's real poke and exit path against the real v2 contracts on a local anvil (a fresh chain, not a fork): the
// compiled AlarmBook, ExitRouter and ERC4626Adapter, the keeper's own pokeTripped, onFired and drainExits, the indexer's
// own applyRouterLog on the arm transaction's logs, and the test database. Everything else in the keeper's suite uses
// mocks; this one proves the calls, gas limits and balance gate work against the contracts that are deployed.
//
// Skipped (with a message) when anvil or the compiled contracts are not available.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, getContractAddress, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { alarmBookAbi, erc20Abi, routerAbi } from "../src/chain/abi";
import { keyOf, presetsFor } from "../src/api/presets";
import { applyRouterLog, type Log } from "../src/indexer/indexer";
import { drainExits, onFired, pokeAndQueue, pokeTripped, type KeeperDeps } from "../src/keeper/keeper";
import { repo } from "../src/store/repo";
import { freshDb } from "./db";
import { contractsBuilt, OUT, ROOT } from "./forge";

const anvilBin = [join(ROOT, ".tools/foundry/v1.8.6/anvil"), Bun.which("anvil")].find((p): p is string => !!p && existsSync(p));
const build = contractsBuilt();
const ready = !!anvilBin && build.ok;
if (!ready) console.warn(`SKIPPED keeper-chain: ${!anvilBin ? "anvil was not found" : build.ok ? "" : (build as { why: string }).why}`);

const PORT = 20_545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
// anvil's first two default accounts: public test keys with no value anywhere.
const dev = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

let proc: Subprocess | undefined;
const client = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 50 });
const devWallet = createWalletClient({ chain: foundry, transport: http(RPC), account: dev });
const ownerWallet = createWalletClient({ chain: foundry, transport: http(RPC), account: owner });

const art = (file: string, name: string) => JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8")).bytecode.object as Hex;
const mockAbi = parseAbi(["function deposit(address,uint256)", "function setPrice(uint256)", "function mint(address,uint256)"]);
const bookAbi = parseAbi(["struct Detector { uint8 kind; address target; uint256 threshold; uint32 window; bytes32 a; bytes32 b; }", "function register(Detector d) returns (bytes32)"]);
const approveAbi = parseAbi(["function approve(address,uint256) returns (bool)"]);

async function deploy(code: Hex, args = "") {
  const hash = await devWallet.sendTransaction({ data: `${code}${args}` as Hex, gas: 12_000_000n });
  return (await client.waitForTransactionReceipt({ hash })).contractAddress!;
}
async function sendAs(wallet: typeof devWallet, to: Address, data: Hex, gas = 5_000_000n) {
  const rc = await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to, data, gas }) });
  if (rc.status !== "success") throw new Error("reverted");
  return rc;
}

let book: Address, router: Address, vault: Address, stable: Address;
let key: Hex;
let posId: Hex;
let armLogs: Log[] = [];
const SHARES = 100n * 10n ** 18n;

beforeAll(async () => {
  if (!ready) return;
  proc = spawn([anvilBin!, "--port", String(PORT), "--silent", "--gas-limit", "100000000"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; ; i++) {
    try { await client.getBlockNumber(); break; } catch { if (i > 100) throw new Error("anvil did not start"); await Bun.sleep(100); }
  }
  const word = (t: string, v: bigint | Address) => encodeAbiParameters([{ type: t }], [v as never]).slice(2);
  stable = await deploy(art("Mocks.sol", "MockERC20"), word("uint8", 6n));
  const weth = await deploy(art("Mocks.sol", "MockERC20"), word("uint8", 18n));
  const feed = await deploy(art("Mocks.sol", "MockFeed"), word("int256", 100_000_000n as never));
  const swap = await deploy(art("Mocks.sol", "MockSwapRouter"), word("address", stable));
  book = await deploy(art("AlarmBook.sol", "AlarmBook"), encodeAbiParameters([{ type: "address" }, { type: "address[]" }], [dev.address, []]).slice(2));
  // The adapter takes the router's address in its constructor and the router takes the adapter's in its own: the adapter
  // is the next deployment after the router, so its address is known in advance.
  const nonce = await client.getTransactionCount({ address: dev.address });
  const adapter = getContractAddress({ from: dev.address, nonce: BigInt(nonce + 1) });
  const expiry = (await client.getBlock()).timestamp + 365n * 86_400n;
  router = await deploy(
    art("ExitRouter.sol", "ExitRouter"),
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint32" }, { type: "uint256" }, { type: "address[]" }],
      [stable, weth, swap, book, dev.address, dev.address, feed, 90_000, expiry, [adapter]],
    ).slice(2),
  );
  expect((await deploy(art("ERC4626Adapter.sol", "ERC4626Adapter"), word("address", router))).toLowerCase()).toBe(adapter.toLowerCase());
  vault = await deploy(art("Mocks.sol", "MockVault"), encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [stable, 1_000_000n]).slice(2));

  // The launch registration of the vault's presets, and the owner's position armed with "Vault loss".
  const loss = presetsFor(vault)[0]!;
  key = loss.key;
  // Only the alarm this test uses: the mock vault has no curator() and starts with no assets, which the other presets need.
  await sendAs(devWallet, book, encodeFunctionData({ abi: bookAbi, functionName: "register", args: [loss.detector] }), 3_000_000n);
  await sendAs(devWallet, vault, encodeFunctionData({ abi: mockAbi, functionName: "deposit", args: [owner.address, SHARES] }));
  await sendAs(ownerWallet, vault, encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [router, 2n ** 256n - 1n] }));
  const rc = await sendAs(ownerWallet, router, encodeFunctionData({
    abi: routerAbi, functionName: "arm",
    args: [{ adapter, target: vault, tokenId: 0n, harbour: 0, maxSlipBps: 0, termsHash: `0x${"33".repeat(32)}`, keys: [key], swaps: [] }],
  }), 3_000_000n);
  armLogs = rc.logs as unknown as Log[];
  posId = (await client.readContract({ address: router, abi: routerAbi, functionName: "positionId", args: [owner.address, adapter, vault, 0n] })) as Hex;
}, 120_000);

afterAll(() => void proc?.kill());

describe.skipIf(!ready)("the keeper against the real v2 contracts", () => {
  test("a share-price drop is poked, fired, queued and exited for the owner, end to end", async () => {
    const db = await freshDb();
    const r = repo(db);
    // The indexer's own code turns the arm transaction's logs into the position the keeper works from.
    for (const l of armLogs) await applyRouterLog(r, l);
    expect((await r.armedWith(key)).map((p) => p.pos_id.toLowerCase())).toEqual([posId.toLowerCase()]);

    let pokeGas = 0n, exitGas = 0n;
    const sent: string[] = [];
    const d = {
      client: client as never, repo: r, router, alarmBook: book, multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11", morpho: "0x0000000000000000000000000000000000000001",
      account: dev.address, paidOnly: false, now: () => Math.floor(Date.now() / 1000), listed: new Set([vault.toLowerCase()]),
      quarantine: new Map<string, number>(), misses: new Map<string, number>(),
      send: async (tx: { to: Address; data: Hex; gas: bigint }) => {
        sent.push(tx.to.toLowerCase());
        if (tx.to.toLowerCase() === book.toLowerCase()) pokeGas = tx.gas; else exitGas = tx.gas;
        const hash = await devWallet.sendTransaction({ to: tx.to, data: tx.data, gas: tx.gas });
        const rc = await client.waitForTransactionReceipt({ hash });
        if (rc.status !== "success") throw new Error(`reverted: ${hash}`);
        return hash;
      },
    } as unknown as KeeperDeps;

    // Nothing has happened to the vault: nothing to poke.
    expect(await pokeTripped(d)).toEqual([]);
    expect(sent).toEqual([]);

    // The share price falls 10%, more than the 0.5% threshold.
    await sendAs(devWallet, vault, encodeFunctionData({ abi: mockAbi, functionName: "setPrice", args: [900_000n] }));
    const before = await client.readContract({ address: stable, abi: erc20Abi, functionName: "balanceOf", args: [owner.address] });
    expect(before).toBe(0n);

    // The keeper's poke fires the alarm on chain and queues the exit; the indexer is not involved.
    await pokeAndQueue(d);
    expect(sent).toEqual([book.toLowerCase()]);
    expect(pokeGas).toBeGreaterThanOrEqual(1_600_000n);
    expect(await client.readContract({ address: book, abi: alarmBookAbi, functionName: "isLive", args: [key, 86_400n] })).toBe(true);
    const queued = await db.query<{ payload: { posId: string; preset: boolean } }>(`SELECT payload FROM jobs WHERE kind='exit' AND NOT done`);
    expect(queued.map((j) => j.payload.posId.toLowerCase())).toEqual([posId.toLowerCase()]);
    expect(queued[0]!.payload.preset).toBe(true);

    // The exit goes out through the balance gate, and the owner is paid in the vault's asset: 100 shares at 0.9.
    await drainExits(d);
    expect(sent).toEqual([book.toLowerCase(), router.toLowerCase()]);
    expect(exitGas).toBeGreaterThan(0n);
    expect(await client.readContract({ address: stable, abi: erc20Abi, functionName: "balanceOf", args: [owner.address] })).toBe(90_000_000n);
    expect(await client.readContract({ address: vault, abi: erc20Abi, functionName: "balanceOf", args: [owner.address] })).toBe(0n);
    expect(await db.query(`SELECT 1 FROM jobs WHERE kind='exit' AND NOT done`)).toEqual([]);
  }, 120_000);

  test("a key that is not one of the vault's presets is not treated as the listed vault's", async () => {
    const db = await freshDb();
    const r = repo(db);
    for (const l of armLogs) await applyRouterLog(r, l);
    // The same position, armed (in the database) with a key of the owner's own choosing.
    const own = `0x${"ab".repeat(32)}` as Hex;
    await r.syncArm(posId, true, [own]);
    const d = { repo: r, paidOnly: false, now: () => 1_000, listed: new Set([vault.toLowerCase()]) } as unknown as KeeperDeps;
    expect(await onFired(d, own, 1_000)).toBe(1);
    const job = (await db.query<{ payload: { preset: boolean } }>(`SELECT payload FROM jobs WHERE kind='exit'`))[0]!;
    expect(job.payload.preset).toBe(false);
    expect(keyOf(presetsFor(vault)[0]!.detector)).toBe(key);
  });
});
