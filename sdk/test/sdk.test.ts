import { expect, test } from "bun:test";
import { decodeFunctionData, maxUint256, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { createCanopy, positionId, toJson, CHAINS } from "../src/index";
import { presetsFor, keyOf, registrationOrder } from "../../services/src/api/presets";
import { routerAbi, alarmBookAbi } from "../../services/src/chain/abi.generated";

const chain = CHAINS[0]!, vault = chain.vaults[0]!.address;
const owner = "0xabababababababababababababababababababab" as Address;
const presets = presetsFor(vault), keys = presets.map((p) => p.key);
const id = positionId(owner, chain.adapter!, vault);
const state = [true, 0n, 1_000_000n, 0n, 100n, 0n, 0n, 100n] as const;

function fixture(opts: { active?: boolean; recorded?: boolean; oldKeys?: Hex[]; harbour?: number; shares?: bigint; unknown?: boolean; failed?: string; wrongChain?: boolean; goingOff?: Hex; unavailable?: boolean; blockedGate?: boolean; swaps?: object[]; simulateFailure?: boolean } = {}) {
  const calls: { functionName: string; address: Address; args: readonly unknown[]; blockNumber: bigint }[] = [];
  const client = {
    getChainId: async () => opts.wrongChain ? 1 : 4663,
    getBlock: async () => ({ number: 100n, timestamp: 1_000_000n }),
    call: async () => { if (opts.simulateFailure) throw new Error("secret RPC URL"); return { data: "0x" }; },
    readContract: async (p: { functionName: string; address: Address; args: readonly unknown[]; blockNumber: bigint }) => {
      calls.push(p);
      if (p.functionName === opts.failed) throw new Error("https://provider.invalid/secret-key");
      switch (p.functionName) {
        case "positions": return [opts.recorded === false ? zeroAddress : owner, 1n, 0n, opts.active ?? false, opts.harbour ?? 0, 75, chain.adapter, vault, vault, false, 0n];
        case "isArmed": return opts.active ?? false;
        case "keysOf": return opts.oldKeys ?? [];
        case "swapsOf": return opts.swaps ?? [];
        case "adapterAllowed": return !opts.unavailable;
        case "armingPaused": return false;
        case "ADMIN_EXPIRY": return 2_000_000n;
        case "paused": throw new Error("No paused() function");
        case "detector": return registrationOrder(vault).find(d => keyOf(d) === p.args[0]) ?? registrationOrder(vault)[0];
        case "state": return opts.unknown ? [false, ...state.slice(1)] : state;
        case "check": return p.args[0] === opts.goingOff;
        case "armable": return p.args[0] !== opts.goingOff;
        case "balanceOf": return opts.shares ?? 1_000_000n;
        case "convertToAssets": return p.args[0];
        case "asset": return chain.planToken;
        case "decimals": return 6;
        case "allowance": return opts.unknown ? 0n : maxUint256;
        case "maxRedeem": return 500_000n;
        case "owner": case "curator": return owner;
        case "sendSharesGate": case "receiveSharesGate": case "receiveAssetsGate":
          if (opts.blockedGate) return vault;
          throw new Error("No gate function");
        case "canSendShares": case "canReceiveShares": case "canReceiveAssets": return false;
        default: throw new Error(`Unexpected read ${p.functionName}`);
      }
    },
  } as unknown as PublicClient;
  return { sdk: createCanopy({ client }), client, calls };
}

test("wallet scan reports failures rather than pretending an unreadable wallet is empty", async () => {
  const { sdk } = fixture({ failed: "balanceOf" });
  const out = await sdk.checkWallet(owner);
  expect(out.complete).toBe(false);
  expect(out.positions).toEqual([]);
  expect(out.failures.length).toBe(chain.vaults.length);
  expect(toJson(out)).not.toContain("secret-key");
});
test("reports raw and decimal amounts, partial liquidity and a coherent block", async () => {
  const { sdk, calls } = fixture();
  const out = await sdk.explainPosition(owner, vault);
  expect(out.position.assetAmount).toBe("1");
  expect(out.position.liquidity).toBe("limited");
  expect(out.unknown.length).toBeGreaterThan(0);
  expect(calls.every((c) => c.blockNumber === 100n)).toBe(true);
  expect(JSON.parse(toJson(out)).position.shares).toBe("1000000");
});
test("keeps even tiny positions; wallet reads have no dust cutoff", async () => {
  expect((await fixture({ shares: 1n }).sdk.checkWallet(owner)).positions[0]!.shares).toBe(1n);
});
test("fails closed for an unsupported network or a wrong RPC chain", async () => {
  expect(() => createCanopy({ chainId: 8453 })).toThrow("no configured live");
  await expect(fixture({ wrongChain: true }).sdk.checkWallet(owner)).rejects.toThrow("different network");
});
test("builds ordered registrations, approval and raw arming from existing app presets", async () => {
  const out = await fixture({ unknown: true }).sdk.armPosition(owner, vault, [keys[3]!]);
  expect(out.kind).toBe("unsigned");
  expect(out.requiresOwnerApproval).toBe(true);
  const registrations = out.transactions.filter((t) => t.to === chain.alarmBook);
  const registered = registrations.map((t) => keyOf(decodeFunctionData({ abi: alarmBookAbi, data: t.data }).args![0] as ReturnType<typeof presetsFor>[number]["detector"]));
  const expected = registrationOrder(vault).filter((d) => [keys[3], ...presets[3]!.requires!.map((p) => p.key)].includes(keyOf(d))).map(keyOf);
  expect(registered).toEqual(expected);
  expect(out.transactions.at(-2)!.purpose).toContain("unlimited");
  const decoded = decodeFunctionData({ abi: routerAbi, data: out.transactions.at(-1)!.data });
  expect(decoded.functionName).toBe("arm");
  expect(decoded.args![0]).toMatchObject({ target: vault, harbour: 0, keys: [keys[3]], swaps: [] });
  expect(out.transactions.every((t) => t.from.toLowerCase() === owner && t.chainId === 4663 && t.value === "0x0")).toBe(true);
  expect(out.terms!.text.length).toBeGreaterThan(0);
});
test("refuses replacement through arm_position, unsupported keys and failed reads", async () => {
  await expect(fixture({ active: true }).sdk.armPosition(owner, vault, [keys[0]!])).rejects.toThrow("Use tighten");
  await expect(fixture().sdk.armPosition(owner, vault, ["0x" + "11".repeat(32)])).rejects.toThrow("list_alarms");
  await expect(fixture({ failed: "state" }).sdk.armPosition(owner, vault, [keys[0]!])).rejects.toThrow("going off or cannot be read");
  await expect(fixture({ unavailable: true }).sdk.armPosition(owner, vault, [keys[0]!])).rejects.toThrow("unavailable");
  await expect(fixture({ shares: 0n }).sdk.armPosition(owner, vault, [keys[0]!])).rejects.toThrow("no shares");
});
test("tighten preserves custom keys and the entire stable payout configuration", async () => {
  const custom = ("0x" + "cc".repeat(32)) as Hex;
  const swaps = [{ token: vault, feed: chain.planToken, heartbeat: 3600, tokenDecimals: 6, path: "0xabcdef" }];
  const out = await fixture({ active: true, harbour: 1, oldKeys: [custom, keys[0]!], swaps }).sdk.tighten(owner, vault, [keys[1]!]);
  const decoded = decodeFunctionData({ abi: routerAbi, data: out.transactions.at(-1)!.data });
  expect(decoded.functionName).toBe("arm");
  // Compare addresses case-insensitively, since ABI decoding checksums them.
  expect(toJson(decoded.args![0]).toLowerCase()).toBe(toJson({ adapter: chain.adapter, target: vault, tokenId: 0n, harbour: 1, maxSlipBps: 75, termsHash: out.terms!.hash, keys: [custom, keys[0], keys[1]], swaps }).toLowerCase());
  expect(out.previousKeys).toEqual([custom, keys[0]!]);
  expect(out.positionId).toBe(id);
});
test("tighten refuses a firing old alarm, a no-op and too many keys", async () => {
  await expect(fixture({ active: true, oldKeys: [keys[0]!], goingOff: keys[0] }).sdk.tighten(owner, vault, [keys[1]!])).rejects.toThrow("existing alarm");
  await expect(fixture({ active: true, oldKeys: [keys[0]!] }).sdk.tighten(owner, vault, [keys[0]!])).rejects.toThrow("already armed");
  const oldKeys = Array.from({ length: 8 }, (_, n) => ("0x" + (n + 10).toString(16).repeat(64)) as Hex);
  await expect(fixture({ active: true, oldKeys }).sdk.tighten(owner, vault, [keys[0]!])).rejects.toThrow("eight-key");
});
test("cannot arm an alarm when its quorum dependency is going off", async () => {
  await expect(fixture({ goingOff: keys[1] }).sdk.armPosition(owner, vault, [keys[2]!])).rejects.toThrow("going off");
});
test("refuses arming when withdrawal gates block the router or adapter", async () => {
  await expect(fixture({ blockedGate: true }).sdk.armPosition(owner, vault, [keys[0]!])).rejects.toThrow("withdrawal gates");
});
test("exit_now simulates an owner exit even after disarming; there is no disarm or signing API", async () => {
  const { sdk } = fixture({ active: false });
  const out = await sdk.exitNow(owner, vault);
  const decoded = decodeFunctionData({ abi: routerAbi, data: out.transactions[0]!.data });
  expect(decoded.functionName).toBe("exit");
  expect(decoded.args).toEqual([id, ("0x" + "00".repeat(32)) as Hex, 0n]);
  expect(Object.keys(sdk).some((k) => /disarm|sign|send|broadcast/i.test(k))).toBe(false);
  await expect(fixture({ recorded: false }).sdk.exitNow(owner, vault)).rejects.toThrow("no recorded");
  await expect(fixture({ simulateFailure: true }).sdk.exitNow(owner, vault)).rejects.toThrow("could not be simulated");
});
test("validates addresses, vaults, hashes and duplicate keys before preparing calldata", async () => {
  const { sdk } = fixture();
  await expect(sdk.checkWallet(zeroAddress)).rejects.toThrow("nonzero");
  await expect(sdk.listAlarms(owner)).rejects.toThrow("listed");
  await expect(sdk.exitReceipt("0x12")).rejects.toThrow("32-byte");
  await expect(sdk.armPosition(owner, vault, [keys[0]!, keys[0]!])).rejects.toThrow("only once");
});

test("cold drain references refuse an unsigned arm even when the key itself reads armable",async()=>{const {sdk,client}=fixture();const read=client.readContract.bind(client);client.readContract=(async(p:any)=>p.functionName==='state'?[true,0n,0n,0n,0n,0n,0n,0n]:read(p)) as typeof client.readContract;await expect(sdk.armPosition(owner,vault,[keys[2]!])).rejects.toThrow('alarm is going off');});
