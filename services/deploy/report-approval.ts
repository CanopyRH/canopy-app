/** Offline operator tool. Does not fetch, classify, sign or publish reports. Human review is required first. */
import { readFileSync } from "node:fs";
import { ReportApprovals } from "../src/watcher/attribution";
import { sha256 } from "../src/watcher/watcher";
export function reportApproval(
  raw: string,
  sourceUrl: string,
  chainId: number,
  targets: string[],
  reviewedAt: number,
  expiresAt: number,
) {
  return ReportApprovals.parse({
    version: 1,
    reports: [
      {
        sha256: sha256(raw),
        sourceUrl,
        chainId,
        targets,
        reviewedAt,
        expiresAt,
      },
    ],
  });
}
if (import.meta.main) {
  const [file, url, chain, targets, expires] = process.argv.slice(2);
  if (!file || !url || !chain || !targets || !expires)
    throw Error(
      "usage: bun deploy/report-approval.ts <exact stored raw text file> <allowlisted HTTPS source> <chain id> <comma-separated verified vault addresses> <expiry unix seconds>",
    );
  const raw = readFileSync(file, "utf8");
  if (Buffer.byteLength(raw) > 2_000_000)
    throw Error("Report exceeds size limit");
  console.log(
    JSON.stringify(
      reportApproval(
        raw,
        url,
        Number(chain),
        targets.split(","),
        Math.floor(Date.now() / 1000),
        Number(expires),
      ),
      null,
      2,
    ),
  );
}
