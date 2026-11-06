// A stand-in node for the keeper's alarm checks. The keeper sends them as `eth_call`s with an explicit gas: one
// Multicall3 aggregate3 of up to CHECKS_PER_CALL checks, or a single AlarmBook.check. This decodes both and lets a test
// answer per key, so a test says which keys read tripped, which revert, and how the request is sized.
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { alarmBookAbi, multicall3Abi } from "../src/chain/abi";

/** What one key's check does: true or false is the answer, "revert" is a failed check (a burner, NotEnoughGas). */
export type CheckAnswer = boolean | "revert";

export interface CheckRequest {
  /** True for a Multicall3 request, false for a single check. */
  shared: boolean;
  keys: Hex[];
  /** The gas the request was sent with. */
  gas: bigint | undefined;
}

export interface CheckNodeOptions {
  /** Answers one key. A key in a shared request sees the whole request, so a test can make a burner sink its neighbours. */
  answer: (key: Hex, req: CheckRequest) => CheckAnswer;
  /** Heard once per request, in order. */
  seen?: { push(r: CheckRequest): unknown };
  /** Makes a whole request fail, as a node does when a call is over its cap. */
  refuse?: (req: CheckRequest) => boolean;
}

/** The `call` a fake client gives the keeper. */
export function checkNode(o: CheckNodeOptions) {
  return async ({ data, gas }: { to: Address; data: Hex; gas?: bigint }): Promise<{ data: Hex }> => {
    let req: CheckRequest;
    let sel: "aggregate3" | "check";
    let keys: Hex[];
    try {
      const calls = decodeFunctionData({ abi: multicall3Abi, data }).args![0] as readonly { callData: Hex }[];
      keys = calls.map((c) => (decodeFunctionData({ abi: alarmBookAbi, data: c.callData }).args as [Hex])[0]);
      sel = "aggregate3";
    } catch {
      keys = [(decodeFunctionData({ abi: alarmBookAbi, data }).args as [Hex])[0]];
      sel = "check";
    }
    req = { shared: sel === "aggregate3", keys, gas };
    o.seen?.push(req);
    if (o.refuse?.(req)) throw new Error("gas required exceeds allowance");
    const answers = keys.map((k) => o.answer(k, req));
    if (sel === "check") {
      if (answers[0] === "revert") throw new Error("out of gas");
      return { data: encodeFunctionResult({ abi: alarmBookAbi, functionName: "check", result: answers[0] as boolean }) };
    }
    const results = answers.map((a) =>
      a === "revert"
        ? { success: false, returnData: "0x" as Hex }
        : { success: true, returnData: encodeFunctionResult({ abi: alarmBookAbi, functionName: "check", result: a }) },
    );
    return { data: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results }) };
  };
}
