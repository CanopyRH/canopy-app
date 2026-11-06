import type { Address, Hex } from "viem";
import { txUrl } from "../chain/addresses";
import { scrubUrls } from "../log";

/** The first retry comes this long after a failure. Each further one waits twice as long, up to the cap. */
export const RETRY_BASE_SEC = 5;
export const RETRY_MAX_SEC = 300;
/** A log that has been failing this long is reported to the operator chat. */
export const STUCK_AFTER_SEC = 300;

export const backoffSec = (attempts: number, base = RETRY_BASE_SEC, max = RETRY_MAX_SEC) => Math.min(max, base * 2 ** Math.min(attempts, 20));

export interface RetryTuning { baseSec: number; maxSec: number; stuckAfterSec: number }

export interface ParkedLog {
  address: Address;
  data: Hex;
  topics: [Hex, ...Hex[]] | [];
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
}

/** What the retry list keeps of a log. Numbers become text, because JSON has no big integers. */
export const toStored = (l: ParkedLog) => ({
  address: l.address, data: l.data, topics: l.topics, blockNumber: l.blockNumber === null ? null : l.blockNumber.toString(), transactionHash: l.transactionHash, logIndex: l.logIndex,
});

export function fromStored(v: unknown): ParkedLog {
  const s = (typeof v === "string" ? JSON.parse(v) : v) as ReturnType<typeof toStored>;
  return { ...s, blockNumber: s.blockNumber === null ? null : BigInt(s.blockNumber) };
}

/**
 * The thing a log is about: its first indexed argument, such as a position, an owner or a key. Logs about the same thing
 * are applied in order, so a log waits behind an earlier failed one that shares it. Everything else carries on.
 */
export const subjectOf = (l: { topics: readonly Hex[] }) => (l.topics[1] ?? "").toLowerCase();

/** Short, with no URLs, because RPC providers put the API key in the address and the text goes to a chat. */
export const cleanError = (e: unknown) => scrubUrls(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);

export interface StuckLog { source: string; tx: string; logIndex: number; block: bigint; attempts: number; sinceSec: number; error: string }

export function stuckLogText(chainId: number, s: StuckLog): string {
  const link = txUrl(chainId, s.tx);
  return [
    `Canopy ops: the ${s.source} indexer could not apply a log for ${Math.round(s.sinceSec / 60)} minutes (block ${s.block}, ${s.attempts} tries).`,
    `Last error: ${s.error}`,
    "It keeps retrying with a longer wait each time, and later logs are not held up. If it never clears, find out why before the next alarm.",
    link ? `Transaction: ${link}` : `Transaction: ${s.tx}`,
  ].join("\n");
}
