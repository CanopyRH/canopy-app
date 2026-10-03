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
