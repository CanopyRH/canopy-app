import type { Address, Hex, PublicClient } from "viem";
import { alarmBookAbi } from "../chain/abi";
import { Kind } from "../api/presets";
import { drainReadiness } from "./drain-reference";
/** Supplements deployed v2: BOTH parts must be clear and DRAIN references must be ready. No recursive arbitrary graphs. */
export async function armReadiness(
  client: Pick<PublicClient, "readContract" | "getBlock">,
  book: Address,
  key: Hex,
  blockNumber?: bigint,
) {
  const b = await client.getBlock(
    blockNumber === undefined ? {} : { blockNumber },
  );
  if (b.number === null) throw new Error("A mined block is required");
  const read = (key: Hex) =>
    Promise.all([
      client.readContract({
        address: book,
        abi: alarmBookAbi,
        functionName: "state",
        args: [key],
        blockNumber: b.number!,
      }),
      client.readContract({
        address: book,
        abi: alarmBookAbi,
        functionName: "armable",
        args: [key],
        blockNumber: b.number!,
      }),
      client.readContract({
        address: book,
        abi: alarmBookAbi,
        functionName: "detector",
        args: [key],
        blockNumber: b.number!,
      }),
    ]);
  const assess = (s: Awaited<ReturnType<typeof read>>) => {
    const [state, armable, d] = s;
    if (!state[0]) return { known: false, armable: false, coverage: "unknown" };
    const coverage =
      d.kind === Kind.DRAIN
        ? drainReadiness(
            { snapAt: state[2], snap: state[4], prevSnap: state[7] },
            d.window,
            b.timestamp,
          )
        : "ready";
    return { known: true, armable: armable && coverage === "ready", coverage };
  };
  const root = await read(key),
    result = assess(root);
  if (result.known && root[2].kind === Kind.BOTH) {
    const parts = await Promise.all([read(root[2].a), read(root[2].b)]);
    const statuses = parts.map(assess);
    result.armable =
      result.armable &&
      parts.every((p) => p[2].kind !== Kind.BOTH) &&
      statuses.every((s) => s.known && s.armable);
    const bad = statuses.find((s) => s.coverage !== "ready");
    if (bad) result.coverage = bad.coverage;
  }
  return result;
}
