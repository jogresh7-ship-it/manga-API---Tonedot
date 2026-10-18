
// Cloudflare Pages "advanced mode" entry (Manga V2.5). Works with drag-and-drop upload, Git, or Wrangler. Adds edge caching.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const h = (url.pathname === "/api/manga" || url.pathname === "/api/mangadex") ? handleManga : url.pathname === "/api/image" ? handleImage : null;
    if (!h) return env.ASSETS.fetch(request);
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const cacheable = url.pathname === "/api/image" || url.searchParams.get("action") === "chapters";
    if (cacheable) { const hit = await caches.default.match(request); if (hit) return hit; }
    const res = await h(url);
    if (cacheable && res.ok) ctx.waitUntil(caches.default.put(request, res.clone()));
    return res;
  }
};
