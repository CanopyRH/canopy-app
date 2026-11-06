import type { Plugin } from "../plugins";
import { rosterReport } from "../watcher/roster";

/** GET /watchers: the approved watchers, when each last signed, and how many of its signatures matched a fired alarm. */
const watchers: Plugin = {
  name: "watchers",
  api: (app, d) => {
    // The per-address read limit covers this route like every other GET. The numbers may be 30 seconds old.
    app.get("/watchers", async (c) => {
      c.header("Cache-Control", "public, max-age=30");
      return c.json(await rosterReport(d.db, d.watchers, d.now()));
    });
  },
};

export default watchers;
