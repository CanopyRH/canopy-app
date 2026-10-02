import { keccak256, stringToHex, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

export const attestTypes = {
  Attest: [
    { name: "key", type: "bytes32" },
    { name: "evidence", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const attestDomain = (alarmBook: Address, chainId: number) => ({
  name: "Canopy AlarmBook",
  version: "1",
  chainId,
  verifyingContract: alarmBook,
});

export function signAttest(acct: PrivateKeyAccount, alarmBook: Address, chainId: number, key: Hex, evidence: Hex, deadline: bigint) {
  return acct.signTypedData({
    domain: attestDomain(alarmBook, chainId),
    types: attestTypes,
    primaryType: "Attest",
    message: { key, evidence, deadline },
  });
}

/** Stable hash of the signals behind an attestation, so peers sign the same evidence. */
export function evidenceHash(signals: unknown[]): Hex {
  return keccak256(stringToHex(canonicalJson(signals)));
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Signers must be strictly ascending (AlarmBook rejects duplicates and unsorted lists). */
export function assembleQuorum(sigs: { signer: Address; sig: Hex }[], k: number) {
  const uniq = [...new Map(sigs.map((s) => [s.signer.toLowerCase(), s])).values()].sort((a, b) =>
    BigInt(a.signer) < BigInt(b.signer) ? -1 : 1,
  );
  if (uniq.length < k) return null;
  return { signers: uniq.map((s) => s.signer), sigs: uniq.map((s) => s.sig) };
}
