import { z } from "zod";
import {
  keccak256,
  stringToHex,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { canonicalJson, attestDomain, attestTypes } from "../watcher/attest";
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const seconds = z.number().int().nonnegative().max(253402300799);
export const EvidenceBundle = z.strictObject({
  version: z.literal(1),
  chainId: z
    .number()
    .int()
    .positive()
    .max(2 ** 32 - 1),
  alarmBook: addr,
  observedAt: seconds,
  attestation: z.strictObject({
    key: hash,
    evidence: hash,
    deadline: z
      .string()
      .regex(/^\d{1,20}$/)
      .refine((s) => BigInt(s) < 2n ** 64n),
    signer: addr,
    sig: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  }),
  signals: z
    .array(
      z.strictObject({
        kind: z.string().min(1).max(80),
        target: addr,
        severity: z.enum(["hard", "soft"]),
        value: z.number().finite(),
        at: seconds,
        evidence: z.string().max(4096),
      }),
    )
    .max(128),
});
export async function verifyEvidence(
  raw: unknown,
  expected: { chainId: number; alarmBook: Address; approved: Address[] },
  now = Math.floor(Date.now() / 1000),
) {
  const r = EvidenceBundle.parse(raw),
    a = r.attestation;
  const reports = [
    ...new Set(
      r.signals
        .filter((s) => s.kind.startsWith("FEED_"))
        .map((s) => s.evidence),
    ),
  ].sort();
  const evidence = keccak256(stringToHex(canonicalJson([a.key, reports])));
  const domainMatches =
    r.chainId === expected.chainId &&
    r.alarmBook.toLowerCase() === expected.alarmBook.toLowerCase();
  const signatureValid = await verifyTypedData({
    address: a.signer as Address,
    domain: attestDomain(r.alarmBook as Address, r.chainId),
    types: attestTypes,
    primaryType: "Attest",
    message: {
      key: a.key as Hex,
      evidence: a.evidence as Hex,
      deadline: BigInt(a.deadline),
    },
    signature: a.sig as Hex,
  }).catch(() => false);
  const approved = expected.approved.some(
    (x) => x.toLowerCase() === a.signer.toLowerCase(),
  );
  const evidenceMatches = evidence === a.evidence;
  const timeValid =
    r.observedAt <= now &&
    BigInt(a.deadline) > BigInt(now) &&
    BigInt(a.deadline) <= BigInt(now + 1200);
  return {
    version: 1,
    feature: "evidence",
    chainId: r.chainId,
    observedAt: { evaluatedAt: now },
    data: {
      signer: a.signer,
      key: a.key,
      signatureValid,
      domainMatches,
      approved,
      evidenceMatches,
      timeValid,
      consistent:
        signatureValid &&
        domainMatches &&
        approved &&
        evidenceMatches &&
        timeValid,
      reportCount: reports.length,
    },
    limitations: [
      "Approval is checked against the list supplied by the verifier, not a fresh chain read. One valid signature is not a quorum.",
      "The signature binds key, shared report hashes and deadline. It does not authenticate every signal field or establish the truth of a report, the archive time, or watcher independence.",
    ],
  };
}
