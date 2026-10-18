// Local dev: node server.js, then open http://localhost:3000 (Node 18+). Cloudflare Pages uses /functions instead.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleManga, handleImage } from "./lib/manga.js";

process.on("unhandledRejection", () => {});
const dir = path.dirname(fileURLToPath(import.meta.url));
const routes = { "/api/manga": handleManga, "/api/mangadex": handleManga, "/api/image": handleImage };

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const h = routes[u.pathname];
  if (h) {
    try {
      const r = await h(u);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    } catch { res.statusCode = 500; return res.end(); }
  }
  if (u.pathname === "/" || u.pathname === "/index.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(fs.readFileSync(path.join(dir, "public", "index.html")));
  }
  res.statusCode = 404; res.end("Not found");
}).listen(process.env.PORT || 3000, () => console.log("Tonedot is running. Open http://localhost:" + (process.env.PORT || 3000)));
