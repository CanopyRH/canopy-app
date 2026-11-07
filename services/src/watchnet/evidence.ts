import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "../watcher/attest";
import { sharedEvidence, type Attestation } from "../watcher/watcher";
import type { Signal } from "../detectors";
/** Archive only data used for this decision. An RPC URL, API key or private key is never part of this schema. */
export async function archiveEvidence(
  directory: string,
  a: Attestation,
  chainId: number,
  book: string,
  signals: Signal[],
  observedAt: number,
) {
  if (sharedEvidence(a.key, signals) !== a.evidence)
    throw new Error("Evidence does not match the signed report set");
  const bundle = {
    version: 1,
    chainId,
    alarmBook: book,
    observedAt,
    attestation: { ...a, deadline: a.deadline.toString() },
    signals,
  };
  const body = canonicalJson(bundle);
  const digest = createHash("sha256").update(body).digest("hex");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${digest}.json`);
  try {
    await writeFile(path, body + "\n", { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code !== "EEXIST" ||
      (await readFile(path, "utf8")) !== body + "\n"
    )
      throw e;
  }
  return { digest, path };
}
