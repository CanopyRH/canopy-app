/** Writes the sample X-ray card for a launch vault, from made-up fixture numbers: bun tools/xray-sample.ts docs/xray-sample.png */
import { writeFileSync } from "node:fs";
import { LAUNCH_CARD } from "../services/test/xray-fixtures";
import { factsFrom, renderPng, renderSvg } from "../services/src/xray/xray";

const out = process.argv[2] ?? "docs/xray-sample.png";
const facts = factsFrom(LAUNCH_CARD, { positions: 3, presets: ["Vault loss", "Exploit confirmed"] });
writeFileSync(out, await renderPng(renderSvg(facts)));
console.log(`wrote ${out}`);
