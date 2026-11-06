import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, parseAbi, type Address, type Hex } from "viem";
import type { Net } from "./chain";
import { keyStatus, presetStatus } from "./alarms";
import { presetsFor } from "../../services/src/api/presets";
import { PREVIEW } from "./copy/preview";
import type { AlarmLine, PreviewDeps, VaultIo } from "./preview";

/** Chain reads for the exit preview. Everything here is a read or a dry run (eth_call), so nothing is ever sent. */

const abi = parseAbi([
  "function previewRedeem(uint256) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const routerKeysAbi = parseAbi(["function keysOf(bytes32) view returns (bytes32[])"]);

/** A vault saying no is an answer. A node that fails to answer is not, so it is thrown on. */
const refused = (e: unknown) => e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError) !== null;

function vaultIo(net: Net, vault: Address, owner: Address): VaultIo {
  const read = <N extends "previewRedeem" | "maxRedeem" | "maxWithdraw">(functionName: N, arg: bigint | Address) =>
    net.client.readContract({ address: vault, abi, functionName, args: [arg] } as never) as Promise<bigint>;
  return {
    previewRedeem: (shares) => read("previewRedeem", shares),
    maxRedeem: () => read("maxRedeem", owner),
    maxWithdraw: () => read("maxWithdraw", owner),
    // The adapter redeems with the router as receiver. The owner as receiver makes the same call, so the same answer.
    redeemNow: (shares) =>
      net.client.simulateContract({ address: vault, abi, functionName: "redeem", args: [shares, owner, owner], account: owner }).then(
        (r) => r.result,
        (e) => {
          if (refused(e)) return null;
          throw e;
        },
      ),
  };
}

/** The alarms behind one position. Armed: the keys it was armed with. Not armed: the presets it could choose. */
async function alarmLines(net: Net, vault: Address, posId: Hex | null): Promise<AlarmLine[] | null> {
  if (!net.live) return null;
  if (posId === null) return (await net.presetViews(vault)).map((v) => ({ name: v.preset.name, status: v.status }));
  const keys = await net.client.readContract({ address: net.chain.router!, abi: routerKeysAbi, functionName: "keysOf", args: [posId] });
  const presets = presetsFor(vault);
  return Promise.all(
    keys.map(async (key): Promise<AlarmLine> => {
      const preset = presets.find((p) => p.key === key);
      return preset ? { name: preset.name, status: await presetStatus(net.alarmIo, preset) } : { name: PREVIEW.customAlarm, status: await keyStatus(net.alarmIo, key) };
    }),
  );
}

/** The reads for one position on one network. `posId` is set only when the position is armed. */
export function chainDeps(net: Net, vault: Address, owner: Address, posId: Hex | null): PreviewDeps {
  return {
    vault: vaultIo(net, vault, owner),
    allowance: () => net.client.readContract({ address: vault, abi, functionName: "allowance", args: [owner, net.chain.router!] }),
    blocked: async () => (net.live ? net.gatesBlock(vault, owner) : null),
    alarms: () => alarmLines(net, vault, posId),
  };
}
