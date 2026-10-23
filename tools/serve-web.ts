/** Local preview of the static web app. Production hosts the same files on IPFS and a normal URL. */
import { join, normalize } from "node:path";

const root = join(import.meta.dir, "../web/public");
const port = Number(process.env.PORT ?? 4173);

Bun.serve({
  port,
  fetch(req) {
    const path = normalize(new URL(req.url).pathname).replace(/^(\.\.[/\\])+/, "");
    const file = Bun.file(join(root, path === "/" ? "index.html" : path));
    return file.exists().then(async (ok) => {
      if (!ok) return new Response("not found", { status: 404 });
      if (!/\.html$/.test(file.name ?? "")) return new Response(file);
      // Local wallets and nodes speak plain http, which the published page refuses.
      return new Response((await file.text()).replace("connect-src https:", "connect-src https: http://localhost:* http://127.0.0.1:*"), { headers: { "content-type": "text/html" } });
    });
  },
});
console.log(`web app on http://localhost:${port}`);
