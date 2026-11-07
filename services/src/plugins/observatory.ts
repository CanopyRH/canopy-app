import type { Plugin } from "../plugins";
import {
  FEATURES,
  LIVE_FEATURES,
  type LiveFeature,
  type ResearchQuery,
} from "../observatory";
import { bounded, ObservatoryError } from "../observatory/core";
import { parseResearchQuery } from "../observatory/query";
export { parseResearchQuery };
export default {
  name: "observatory",
  api: (app, d) => {
    let active = 0;
    const cache = new Map<string, { until: number; value: unknown }>();
    app.get("/research", (c) => c.json({ version: 1, features: FEATURES }));
    app.get("/research/:feature", async (c) => {
      c.header("Cache-Control", "no-store");
      const feature = c.req.param("feature");
      if (!(LIVE_FEATURES as readonly string[]).includes(feature))
        return c.json(
          {
            error: "This feature runs locally or does not exist.",
            code: "unknown_feature",
          },
          404,
        );
      let q: ResearchQuery;
      try {
        q = parseResearchQuery(feature, [
          ...new URL(c.req.url).searchParams.entries(),
        ]);
      } catch {
        return c.json(
          { error: "Invalid research parameters.", code: "bad_query" },
          400,
        );
      }
      if (!d.research)
        return c.json(
          {
            error: "Research reads are not configured on this deployment.",
            code: "not_configured",
          },
          503,
        );
      const key = JSON.stringify([feature, q]),
        cached = q.owner ? undefined : cache.get(key);
      if (cached && d.now() < cached.until && d.now() >= cached.until - 10)
        return c.json(cached.value as object);
      if (active >= 2) {
        c.header("Retry-After", "5");
        return c.json(
          {
            error: "Research readers are busy. Try again shortly.",
            code: "busy",
          },
          503,
        );
      }
      active++;
      const job = Promise.resolve()
        .then(() => d.research!(feature as LiveFeature, q))
        .finally(() => {
          active--;
        });
      try {
        const value = await bounded(job, 30_000);
        if (!q.owner) {
          if (cache.size >= 64) cache.delete(cache.keys().next().value!);
          cache.set(key, { until: d.now() + 10, value });
        }
        return c.json(value as object);
      } catch (e) {
        return c.json(
          {
            error:
              e instanceof ObservatoryError
                ? e.message
                : "The source could not be read. No conclusion was produced.",
            code: e instanceof ObservatoryError ? e.code : "source_unavailable",
          },
          502,
        );
      }
    });
  },
} satisfies Plugin;
