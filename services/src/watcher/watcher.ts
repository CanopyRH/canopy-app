import { createHash } from "node:crypto";
import { encodeFunctionData, recoverTypedDataAddress, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { alarmBookAbi } from "../chain/abi";
import type { Signal } from "../detectors";
import { decide } from "../engine/decide";
import type { Classify } from "../engine/classifier";
import type { Classification } from "../engine/llmClassify";
import type { Db } from "../store/db";
import { assembleQuorum, attestDomain, attestTypes, evidenceHash, signAttest } from "./attest";

export interface Attestation { key: Hex; evidence: Hex; deadline: bigint; signer: Address; sig: Hex }

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface LabelledItem { classification: Classification; hash: string }

/** Labels a new feed item once, whichever vaults it turns out to concern. Only allowlisted URLs reach this. */
export async function ingestFeed(db: Db, classify: Classify, sourceUrl: string, text: string, at: number): Promise<LabelledItem | null> {
  const hash = sha256(text);
  await db.query(`INSERT INTO feed_items (sha256, source_url, raw, at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [hash, sourceUrl, text, at]);
  // An outage must not lose a report, so an unlabelled item stays open for a few tries. A refusal costs the same few tries.
  const open = await db.query(`UPDATE feed_items SET tries=tries+1 WHERE sha256=$1 AND label IS NULL AND tries<$2 RETURNING sha256`, [hash, MAX_LABEL_TRIES]);
  if (open.length === 0) return null;
  const c = await classify(sourceUrl, text);
  if (!c) return null;
  await db.query(`UPDATE feed_items SET label=$2, protocol=$3, confidence=$4, at=$5 WHERE sha256=$1`, [hash, c.label, c.protocol, c.confidence, at]);
  return { classification: c, hash };
}

const MAX_LABEL_TRIES = 5;
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Too common to identify a vault, such as token symbols. */
const GENERIC = new Set(["usdc", "usd", "usdg", "usdt", "dai", "eth", "weth", "btc", "the", "vault", "vaults", "protocol", "finance", "financial", "labs", "dao", "prime", "high", "yield", "core", "v1", "v2"]);
/** Every launch vault runs on these, so a report about one concerns them all. */
const PLATFORMS = new Set(["morpho"]);

/** Vaults a report is about, by name. A wide match only adds soft signals, which still need on-chain evidence. */
export function matchVaults<T extends { name: string }>(protocol: string, vaults: T[]): T[] {
  const named = words(protocol);
  if (named.some((w) => PLATFORMS.has(w))) return vaults;
  return vaults.filter((v) => words(v.name).some((n) => !GENERIC.has(n) && n.length >= 4 && named.some((w) => w === n || w.startsWith(n))));
}

/** Independent watchers must sign identical values, so the deadline comes from a shared 10-minute window. */
export const sharedDeadline = (now: number) => BigInt(Math.floor(now / 600) * 600 + 1200);

/** Reports both operators saw, by content hash. On-chain details can differ between operators, so they stay out. */
export function sharedEvidence(key: Hex, signals: Signal[]): Hex {
  const reports = [...new Set(signals.filter((s) => s.kind.startsWith("FEED_")).map((s) => s.evidence))].sort();
  return evidenceHash([key, reports]);
}

/** Signs only when the decision rules say so. The LLM has no path to this function except through decide(). */
export async function maybeAttest(acct: PrivateKeyAccount, alarmBook: Address, chainId: number, key: Hex, signals: Signal[], now: number): Promise<Attestation | null> {
  const d = decide(signals);
  if (d.path !== "ATTEST") return null;
  const evidence = sharedEvidence(key, d.signals);
  const deadline = sharedDeadline(now);
  return { key, evidence, deadline, signer: acct.address, sig: await signAttest(acct, alarmBook, chainId, key, evidence, deadline) };
}

/** Labelled reports from the last hour. Rechecked every cycle, because the on-chain signal may arrive later. */
export async function recentReports(db: Db, since: number) {
  const rows = await db.query<{ sha256: string; label: string; protocol: string; confidence: number }>(
    `SELECT sha256, label, protocol, confidence FROM feed_items WHERE at>$1 AND label IS NOT NULL`,
    [since],
  );
  return rows.map((x) => ({
    hash: x.sha256,
    classification: { label: x.label, protocol: x.protocol, confidence: Number(x.confidence) } as Classification,
  }));
}
