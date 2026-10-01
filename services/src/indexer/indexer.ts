import { decodeEventLog, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";
import { alarmBookAbi, erc20Abi, routerAbi } from "../chain/abi";
import { daysFor, extendPlan } from "../billing/prepaid";
import type { Db } from "../store/db";
import type { Repo } from "../store/repo";

const lc = (a: string) => a.toLowerCase();

export interface Log {
  address: Address;
  data: Hex;
  topics: [Hex, ...Hex[]] | [];
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
}

/** Applies one router log. Safe to replay: every write is an upsert. */
export async function applyRouterLog(r: Repo, log: Log) {
  const ev = decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics as never, strict: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = ev.args as unknown as Record<string, any>;
  switch (ev.eventName) {
    case "Armed": {
      const owner = lc(a.owner as string);
      await r.upsertPosition({
        posId: a.posId, owner, adapter: lc(a.adapter as string), target: lc(a.target as string), tokenId: a.tokenId,
        harbour: Number(a.harbour), maxSlipBps: Number(a.maxSlipBps), epoch: await r.epochOf(owner), block: log.blockNumber ?? 0n,
        termsHash: a.termsHash, keys: a.keys as readonly string[],
      });
      break;
    }
    case "Disarmed":
      await r.disarm(a.posId);
      break;
    case "DisarmedAll":
      await r.disarmAll(lc(a.owner as string), BigInt(a.newEpoch));
      break;
    case "Exited":
      await r.recordExit({
        exitId: a.exitId, posId: a.posId, owner: lc(a.owner as string), caller: lc(a.caller as string), alarmKey: a.alarmKey, viaAlarm: a.viaAlarm,
        tx: log.transactionHash!, block: log.blockNumber ?? 0n,
      });
      break;
    case "Paid":
      await r.recordPayout({ exitId: a.exitId, tx: log.transactionHash!, logIndex: log.logIndex!, token: lc(a.token as string), amount: a.amount, swapped: a.swapped });
      break;
    case "Owed":
      await r.addOwed(log.transactionHash!, log.logIndex!, lc(a.owner as string), lc(a.token as string), a.amount);
      break;
    case "OwedClaimed":
      await r.clearOwed(lc(a.owner as string), lc(a.token as string));
      break;
  }
}
