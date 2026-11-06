import type { Address, PublicClient } from "viem";
import { alarmBookAbi, routerAbi } from "./abi";
import type { Repo } from "../store/repo";
import { queueOps, sendQueuedOps } from "../bot/queue";

/**
 * The startup contract-version check. v2 added views that v1 does not have (the router's MAX_SWAPS and the AlarmBook's
 * REBASE_AFTER). A service that starts on v1 addresses by mistake would index and act on the wrong contracts, so each
 * one reads both views before it touches the database and refuses to start unless they answer.
 */

/** Why a service will not start. `not-v2` means a contract answered but is not v2; `unreadable` means the node gave no answer. */
export class ContractVersionError extends Error {
  constructor(message: string, readonly kind: "not-v2" | "unreadable") {
    super(message);
  }
}

type Reader = Pick<PublicClient, "readContract">;

/** A contract that reverts or has no code is not v2. Anything else (timeouts, HTTP errors) says nothing about the contract. */
const isAnswerOfNo = (e: unknown) => {
  const err = e as { walk?: (fn: (x: unknown) => boolean) => unknown };
  const names = new Set(["ContractFunctionRevertedError", "ContractFunctionZeroDataError"]);
  return Boolean(err.walk?.((x) => names.has((x as { name?: string }).name ?? "")));
};

async function probe(client: Reader, address: Address, abi: typeof routerAbi | typeof alarmBookAbi, fn: "MAX_SWAPS" | "REBASE_AFTER"): Promise<"yes" | "no" | "unreadable"> {
  try {
    const v = await client.readContract({ address, abi, functionName: fn } as never);
    return typeof v === "bigint" ? "yes" : "no";
  } catch (e) {
    return isAnswerOfNo(e) ? "no" : "unreadable";
  }
}

/**
 * Reads MAX_SWAPS() on the router and REBASE_AFTER() on the AlarmBook. Throws ContractVersionError unless both answer.
 * A node that gives no answer is tried again a few times first, because that says nothing about which contracts these are.
 */
export async function requireV2(client: Reader, a: { router: string; alarmBook: string }, opts: { tries?: number; sleep?: (ms: number) => Promise<unknown> } = {}) {
  const tries = opts.tries ?? 3, sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  let last: ContractVersionError | undefined;
  for (let i = 0; i < tries; i++) {
    const [router, book] = await Promise.all([
      probe(client, a.router as Address, routerAbi, "MAX_SWAPS"),
      probe(client, a.alarmBook as Address, alarmBookAbi, "REBASE_AFTER"),
    ]);
    if (router === "yes" && book === "yes") return;
    const no: string[] = [];
    if (router === "no") no.push(`ROUTER ${a.router} does not answer MAX_SWAPS(), so it is not the v2 ExitRouter`);
    if (book === "no") no.push(`ALARM_BOOK ${a.alarmBook} does not answer REBASE_AFTER(), so it is not the v2 AlarmBook`);
    if (no.length > 0) throw new ContractVersionError(`${no.join("; ")}. A service must run on the v2 contracts.`, "not-v2");
    last = new ContractVersionError(`could not read the version of ROUTER ${a.router} and ALARM_BOOK ${a.alarmBook}: the node gave no answer`, "unreadable");
    if (i + 1 < tries) await sleep(2_000);
  }
  throw last!;
}

/**
 * Tells the operators a service refused to start. The message is queued first, so any running service delivers it, then this
 * process tries to send it itself for a few seconds, because it is about to exit.
 */
export async function announceRefusal(
  r: Repo,
  e: ContractVersionError,
  a: { router: string; alarmBook: string },
  send: ((text: string) => Promise<unknown>) | undefined,
  now: () => number,
  waitMs = 5_000,
) {
  const text = `Canopy ops: a service refused to start. ${e.message}`;
  await queueOps(r, `version:${e.kind}:${a.router.toLowerCase()}:${a.alarmBook.toLowerCase()}`, text, now());
  if (!send) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise((resolve) => (timer = setTimeout(resolve, waitMs)));
  try {
    await Promise.race([sendQueuedOps(r, send, now), limit]);
  } catch { /* the queued row is still there for another service */ }
  clearTimeout(timer);
}
