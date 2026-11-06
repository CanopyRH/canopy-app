// Independent PoC: one gas-burning PAUSED key makes pokeTripped's multicall chunk fail, so no tripped key in it is poked.
import { expect, test } from "bun:test";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pokeTripped, type KeeperDeps } from "../src/keeper/keeper";
import { alarmBookAbi } from "../src/chain/abi";

const OUT = "/tmp/claude/canopy-audit/run/contracts/out";
const art = async (p: string) => (await Bun.file(`${OUT}/${p}`).json()) as { abi: never; bytecode: { object: Hex } };
const RPC = "http://127.0.0.1:18545";
// Anvil default key #0 (public test key)
const acct = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const pub = createPublicClient({ transport: http(RPC), pollingInterval: 50 });
const wal = createWalletClient({ account: acct, transport: http(RPC), chain: null });

async function deploy(p: string, args: unknown[] = []): Promise<Address> {
  const a = await art(p);
  const hash = await wal.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args } as never);
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
}
async function write(address: Address, functionName: string, args: unknown[]) {
  const hash = await wal.writeContract({ address, abi: alarmBookAbi, functionName, args } as never);
  await pub.waitForTransactionReceipt({ hash });
}

test("one burner key hides every tripped key in its chunk from pokeTripped", async () => {
  const book = await deploy("AlarmBook.sol/AlarmBook.json", [acct.address]);
  const mc = await deploy("IndepGasBurner.t.sol/MC3.json");
  const pt = await deploy("IndepGasBurner.t.sol/PausedTrue.json");
  const burner = await deploy("IndepGasBurner.t.sol/Burner.json");
  const Z = `0x${"00".repeat(32)}` as Hex;
  const honest: Hex[] = [];
  for (let i = 0n; i < 120n; i++) {
    const d = { kind: 2, target: pt, threshold: i, window: 0, a: Z, b: Z };
    await write(book, "register", [d]);
    honest.push(await pub.readContract({ address: book, abi: alarmBookAbi, functionName: "keyOf", args: [d] } as never));
  }
  const burnKeys: Hex[] = [];
  for (const t of [0n, 1n]) {
    const bd = { kind: 2, target: burner, threshold: t, window: 0, a: Z, b: Z };
    await write(book, "register", [bd]);
    burnKeys.push((await pub.readContract({ address: book, abi: alarmBookAbi, functionName: "keyOf", args: [bd] } as never)) as Hex);
  }

  const run = async (keys: Hex[]) => {
    const sent: Hex[] = [];
    const d = {
      client: pub, alarmBook: book, multicall3: mc, paidOnly: false, now: () => 0,
      repo: { liveKeys: async () => keys, bump: async () => {} },
      send: async (tx: { data: Hex }) => (sent.push(tx.data), "0x" as Hex),
    } as unknown as KeeperDeps;
    return (await pokeTripped(d)).length;
  };
  const control = await run(honest);
  const oneBurner = await run([honest[0]!, burnKeys[0]!, ...honest.slice(1)]);
  const twoBurners40 = await run([burnKeys[0]!, ...honest.slice(0, 20), burnKeys[1]!, ...honest.slice(20, 40)]);
  console.log(`control poked ${control}/120; one burner among 120: poked ${oneBurner}/120; two burners among 40: poked ${twoBurners40}/40`);
  expect(control).toBe(120);
  expect(oneBurner).toBe(0);
  expect(twoBurners40).toBe(0);
}, 120_000);
