/** Rebuilds the bundled sanctions list from OFAC's published SDN file. Run in CI on a schedule. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const URL_SDN = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML";

export function extractAddresses(xml: string): string[] {
  const found = new Set<string>();
  for (const m of xml.matchAll(/<idType>Digital Currency Address - [A-Z0-9]+<\/idType>\s*<idNumber>(0x[0-9a-fA-F]{40})<\/idNumber>/g)) {
    found.add(m[1]!.toLowerCase());
  }
  return [...found].sort();
}

if (import.meta.main) {
  const xml = await (await fetch(URL_SDN)).text();
  const list = extractAddresses(xml);
  if (list.length < 100) throw new Error(`refusing to save a suspiciously short list: ${list.length}`);
  const out = { source: URL_SDN, fetched: new Date().toISOString().slice(0, 10), addresses: list };
  writeFileSync(join(import.meta.dir, "../web/src/sanctioned.json"), `${JSON.stringify(out)}\n`);
  console.log(`saved ${list.length} addresses`);
}
