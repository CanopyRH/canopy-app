import { FEATURES } from "../../services/src/observatory";
export { FEATURES };
export {
  sessionPlan,
  sessionIcs,
} from "../../services/src/observatory/sessions";
export { verifyEvidence } from "../../services/src/observatory/evidence";
export { verifyHeartbeat } from "../../services/src/observatory/heartbeat";
export { compareReports } from "../../services/src/observatory/changes";

export async function readResearch(
  base: string,
  feature: string,
  q: Record<string, string>,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  if (!FEATURES.some((f) => f.id === feature && f.mode === "live"))
    throw new Error("Choose a live reader.");
  const url = new URL(`/research/${feature}`, base);
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("Invalid API address.");
  for (const [k, v] of Object.entries(q)) if (v) url.searchParams.set(k, v);
  const response = await fetcher(url, {
    signal: signal ?? AbortSignal.timeout(35000),
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  if (!response.body) throw new Error("The reader returned no report.");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > 2_000_000)
        throw new Error("The report exceeds the download limit.");
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("The reader returned an invalid report.");
  }
  if (!response.ok)
    throw new Error(
      response.status === 503
        ? "The reader is busy or this API has not enabled the new tools yet. Try again later."
        : "The source could not be read. Check the selected vault and inputs.",
    );
  if (
    body?.version !== 1 ||
    body.feature !== feature ||
    !Number.isSafeInteger(body.chainId) ||
    !body.observedAt ||
    typeof body.data !== "object" ||
    body.data === null ||
    !Array.isArray(body.limitations) ||
    body.limitations.length > 32 ||
    body.limitations.some(
      (s: unknown) => typeof s !== "string" || s.length > 4000,
    )
  )
    throw new Error("The reader returned an invalid report.");
  return body;
}
export async function readResearchFile(file: Pick<File, "size" | "text">) {
  if (file.size > 2_000_000)
    throw new Error("Choose a JSON file smaller than 2 MB.");
  return JSON.parse(await file.text());
}
