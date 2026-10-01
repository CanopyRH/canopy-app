import { beforeEach, describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { alarmBookAbi, erc20Abi, routerAbi } from "../src/chain/abi";
import { applyPayment, applyRouterLog, decodeFired, syncLogs, type Log } from "../src/indexer/indexer";
import { migrate, type Db } from "../src/store/db";
import { freshDb } from "./db";
import { repo, type Repo } from "../src/store/repo";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const V = "0x00000000000000000000000000000000000000c3" as Address;
const P = `0x${"11".repeat(32)}` as Hex;
const K = `0x${"22".repeat(32)}` as Hex;

function armedLog(posId = P, owner = A, keys: Hex[] = [K]): Log {
  const ev = routerAbi.find((x) => x.type === "event" && x.name === "Armed")!;
  const topics = encodeEventTopics({ abi: routerAbi, eventName: "Armed", args: { posId, owner } as never });
  const data = encodeAbiParameters(
    (ev as { inputs: readonly { indexed?: boolean; type: string; name: string }[] }).inputs.filter((i) => !i.indexed),
    [B, V, 0n, 0, 0, `0x${"33".repeat(32)}`, keys] as never,
  );
  return { address: A, data, topics: topics as never, blockNumber: 7n, transactionHash: `0x${"44".repeat(32)}`, logIndex: 0 };
}

function transferLog(from: Address, value: bigint, logIndex = 0, tx: Hex = `0x${"55".repeat(32)}`): Log {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to: B } });
  return { address: V, data: encodeAbiParameters([{ type: "uint256" }], [value]), topics: topics as never, blockNumber: 1n, transactionHash: tx, logIndex };
}

let r: Repo;
let db: Db;
beforeEach(async () => {
  db = await freshDb();
  r = repo(db);
});

describe("indexer", () => {
  test("Armed creates a position with its keys, and replays are harmless", async () => {
    await applyRouterLog(r, armedLog());
    await applyRouterLog(r, armedLog());
    const pos = await r.armedWith(K);
    expect(pos).toHaveLength(1);
    expect(pos[0]!.owner).toBe(A.toLowerCase());
    expect(pos[0]!.target).toBe(V.toLowerCase());
  });

  test("Disarmed removes a position from keeper work", async () => {
    await applyRouterLog(r, armedLog());
    const topics = encodeEventTopics({ abi: routerAbi, eventName: "Disarmed", args: { posId: P, owner: A } as never });
    await applyRouterLog(r, { ...armedLog(), data: "0x", topics: topics as never });
    expect(await r.armedWith(K)).toHaveLength(0);
  });

  test("DisarmedAll drops every position, and a later arm uses the new epoch", async () => {
    await applyRouterLog(r, armedLog(P));
    await applyRouterLog(r, armedLog(`0x${"12".repeat(32)}`));
    const topics = encodeEventTopics({ abi: routerAbi, eventName: "DisarmedAll", args: { owner: A } as never });
    await applyRouterLog(r, { ...armedLog(), data: encodeAbiParameters([{ type: "uint64" }], [1n]), topics: topics as never });
    expect(await r.armedWith(K)).toHaveLength(0);
    await applyRouterLog(r, armedLog(P));
    const pos = await r.armedWith(K);
    expect(pos).toHaveLength(1);
    expect(Number(pos[0]!.epoch)).toBe(1);
  });

  test("Fired decodes with its evidence", () => {
    const topics = encodeEventTopics({ abi: alarmBookAbi, eventName: "Fired", args: { key: K, target: V } as never });
    const data = encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "bytes32" }], [5, B, P]);
    const f = decodeFired({ ...armedLog(), data, topics: topics as never });
    expect(f?.key).toBe(K);
    expect(f?.evidence).toBe(P);
  });
});
