import { expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { serializeCompactSignature, parseSignature, signatureToCompactSignature, type Address, type Hex } from "viem";
import { freshDb } from "./db";
import { acceptAttestation } from "../src/watcher/watcher";
import { signAttest } from "../src/watcher/attest";
const BOOK = "0x00000000000000000000000000000000000000aa" as Address;
const KEY = `0x${"22".repeat(32)}` as Hex, EV = `0x${"33".repeat(32)}` as Hex;
const w = privateKeyToAccount(`0x${"a1".padStart(64, "0")}`);
test("64-byte compact (EIP-2098) form of a watcher signature", async () => {
  const db = await freshDb();
  const sig = await signAttest(w, BOOK, 8453, KEY, EV, 2000n);
  const compact = serializeCompactSignature(signatureToCompactSignature(parseSignature(sig)));
  const ok = await acceptAttestation(db, [w.address], BOOK, 8453, { key: KEY, evidence: EV, deadline: 2000n, signer: w.address, sig: compact }, 100).catch((e) => "throws: " + String(e).slice(0, 80));
  console.log("compact len", compact.length, "accepted:", ok);
  const genuine = await acceptAttestation(db, [w.address], BOOK, 8453, { key: KEY, evidence: EV, deadline: 2000n, signer: w.address, sig }, 100);
  const rows = await db.query<{ sig: string }>(`SELECT sig FROM attestations`);
  console.log("genuine returns", genuine, "stored lengths:", rows.map((x) => x.sig.length));
});
