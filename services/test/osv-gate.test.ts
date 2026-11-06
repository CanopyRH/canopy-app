// The severity gate of the dependency advisory job (tools/osv-gate.ts), fed osv-scanner-shaped reports.
import { describe, expect, test } from "bun:test";
import { blocking, cvss3, findings } from "../../tools/osv-gate";

const pkg = (name: string, version: string, vulnerabilities: unknown[], groups: unknown[] = []) => ({ package: { name, version, ecosystem: "npm" }, vulnerabilities, groups });
const report = (...packages: ReturnType<typeof pkg>[]) => ({ results: [{ source: { path: "/w/services/bun.lock", type: "lockfile" }, packages }] }) as never;

describe("CVSS v3 base scores", () => {
  test("match the published scores", () => {
    expect(cvss3("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
    expect(cvss3("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H")).toBe(10);
    expect(cvss3("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe(6.1);
    expect(cvss3("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H")).toBe(7.5);
    expect(cvss3("CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N")).toBe(5.5);
    expect(cvss3("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
  });
  test("other vectors are not scored", () => {
    expect(cvss3("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N")).toBeNull();
    expect(cvss3("nonsense")).toBeNull();
    expect(cvss3("CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBeNull();
  });
});

describe("what fails the job", () => {
  test("a clean report has nothing", () => {
    expect(findings({ results: [] })).toEqual([]);
    expect(findings({})).toEqual([]);
  });

  test("a High or Critical advisory fails, by osv-scanner's group score, the advisory's label or its CVSS vector", () => {
    const r = report(
      pkg("a", "1.0.0", [{ id: "GHSA-1" }], [{ ids: ["GHSA-1"], max_severity: "7.5" }]),
      pkg("b", "2.0.0", [{ id: "GHSA-2", database_specific: { severity: "CRITICAL" } }]),
      pkg("c", "3.0.0", [{ id: "GHSA-3", severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] }]),
      pkg("d", "4.0.0", [{ id: "GHSA-4", database_specific: { severity: "HIGH" } }]),
    );
    const all = findings(r);
    expect(all.map((f) => f.level)).toEqual(["high", "critical", "critical", "high"]);
    expect(blocking(all)).toHaveLength(4);
    expect(all[0]).toMatchObject({ package: "a", version: "1.0.0", lockfile: "/w/services/bun.lock", score: 7.5 });
  });

  test("Moderate and Low advisories are listed and do not fail", () => {
    const all = findings(report(
      pkg("m", "1.0.0", [{ id: "GHSA-5", database_specific: { severity: "MODERATE" } }]),
      pkg("l", "1.0.0", [{ id: "GHSA-6" }], [{ ids: ["GHSA-6"], max_severity: "3.1" }]),
      pkg("v", "1.0.0", [{ id: "GHSA-7", severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N" }] }]),
    ));
    expect(all.map((f) => f.level)).toEqual(["lower", "lower", "lower"]);
    expect(blocking(all)).toEqual([]);
  });

  test("the highest score any part of the report gives wins", () => {
    const [f] = findings(report(pkg("x", "1.0.0", [{ id: "GHSA-8", database_specific: { severity: "LOW" }, severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" }] }])));
    expect(f).toMatchObject({ level: "high", score: 7.5 });
  });

  test("an advisory with no severity anywhere is unrated, and does not fail", () => {
    const all = findings(report(pkg("u", "1.0.0", [{ id: "MAL-1" }, { id: "GHSA-9", severity: [{ type: "CVSS_V4", score: "CVSS:4.0/AV:N" }] }])));
    expect(all.map((f) => f.level)).toEqual(["unrated", "unrated"]);
    expect(blocking(all)).toEqual([]);
  });
});
