// The gate for the dependency advisory job in .github/workflows/ci.yml. osv-scanner lists every known advisory against the
// lockfiles but has no severity threshold of its own, so this reads its JSON and fails on High (CVSS 7.0 and up) or
// Critical (9.0 and up) ones. An advisory with no severity anywhere in the report is listed as unrated and does not fail.
//
//   bun tools/osv-gate.ts osv-results.json
import { readFileSync } from "node:fs";

export const HIGH = 7.0;
export const CRITICAL = 9.0;

interface Osv {
  id: string;
  aliases?: string[];
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
}
interface Report {
  results?: { source?: { path?: string }; packages?: { package: { name: string; version: string }; vulnerabilities?: Osv[]; groups?: { ids: string[]; max_severity?: string }[] }[] }[];
}
export interface Finding { id: string; package: string; version: string; lockfile: string; score: number | null; level: "critical" | "high" | "lower" | "unrated" }

const round1 = (x: number) => Math.ceil(x * 10 - 1e-9) / 10;

/** The base score of a CVSS v3.0 or v3.1 vector, or null for any other kind of vector. */
export function cvss3(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const m = Object.fromEntries(vector.split("/").slice(1).map((p) => p.split(":") as [string, string]));
  const changed = m.S === "C";
  const av = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV as string];
  const ac = { L: 0.77, H: 0.44 }[m.AC as string];
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR as string];
  const ui = { N: 0.85, R: 0.62 }[m.UI as string];
  const cia = (k: string) => ({ H: 0.56, L: 0.22, N: 0 })[m[k] as string];
  const [c, i, a] = [cia("C"), cia("I"), cia("A")];
  if ([av, ac, pr, ui, c, i, a].some((x) => x === undefined) || (m.S !== "U" && m.S !== "C")) return null;
  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av! * ac! * pr! * ui!;
  return round1(Math.min((changed ? 1.08 : 1) * (impact + exploitability), 10));
}

const LABELS: Record<string, number> = { CRITICAL: CRITICAL, HIGH: HIGH, MODERATE: 4.0, MEDIUM: 4.0, LOW: 0.1 };

/** The highest severity any part of the report gives one advisory: osv-scanner's own group score, the advisory's label, its CVSS v3 vector. */
function scoreOf(v: Osv, groupScore: number | null): number | null {
  const seen: number[] = [];
  if (groupScore !== null) seen.push(groupScore);
  const label = v.database_specific?.severity?.toUpperCase();
  if (label && label in LABELS) seen.push(LABELS[label]!);
  for (const s of v.severity ?? []) {
    const n = cvss3(s.score);
    if (n !== null) seen.push(n);
  }
  return seen.length > 0 ? Math.max(...seen) : null;
}

/** Every advisory in an osv-scanner JSON report, with its severity. */
export function findings(report: Report): Finding[] {
  const out: Finding[] = [];
  for (const res of report.results ?? []) {
    for (const p of res.packages ?? []) {
      const groups = new Map<string, number>();
      for (const g of p.groups ?? []) {
        const n = Number(g.max_severity);
        if (g.max_severity && Number.isFinite(n)) for (const id of g.ids) groups.set(id, n);
      }
      for (const v of p.vulnerabilities ?? []) {
        const score = scoreOf(v, groups.get(v.id) ?? null);
        const level = score === null ? "unrated" : score >= CRITICAL ? "critical" : score >= HIGH ? "high" : "lower";
        out.push({ id: v.id, package: p.package.name, version: p.package.version, lockfile: res.source?.path ?? "", score, level });
      }
    }
  }
  return out;
}

/** The findings that fail the job. */
export const blocking = (all: Finding[]) => all.filter((f) => f.level === "critical" || f.level === "high");

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: bun tools/osv-gate.ts osv-results.json");
    process.exit(2);
  }
  const all = findings(JSON.parse(readFileSync(file, "utf8")) as Report);
  for (const f of all) console.log(`${f.level.padEnd(8)} ${f.score ?? "-"}\t${f.id}\t${f.package}@${f.version}\t${f.lockfile}`);
  const bad = blocking(all);
  console.log(`${all.length} known advisories, ${bad.length} High or Critical, ${all.filter((f) => f.level === "unrated").length} unrated`);
  if (bad.length > 0) process.exit(1);
}
