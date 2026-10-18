// Manga V2.5: multi-provider manga backend (MangaDex + Comick + Mangapill).
// All providers run in parallel and fail independently. Their chapters are merged by chapter number into ONE list,
// and every merged chapter keeps a list of sources, so if one provider is missing a chapter (or its pages are broken)
// the reader falls back to the next provider automatically.
const VERSION = "2.5";
const UA_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const cache = new Map(), pending = new Map(), lanes = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const throttle = (lane, gap) => { const p = (lanes.get(lane) || Promise.resolve()).then(() => sleep(gap)); lanes.set(lane, p); return p; };
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const num = v => (v == null || v === "" || isNaN(v) ? null : parseFloat(v));
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...extra } });
const withTimeout = (p, ms, label) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(label + " timed out")), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });

// Shared fetch helper: retries, per-provider rate-limit lanes, caching, de-duplication of identical in-flight requests.
async function get(url, o = {}) {
  const { ttl = 300000, kind = "json", headers = {}, gap = 0, lane = "x", tries = 3 } = o;
  const key = kind + "|" + url, hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  if (pending.has(key)) return pending.get(key);
  const host = new URL(url).hostname;
  const p = (async () => {
    let err;
    for (let i = 0; i < tries; i++) {
      if (gap) await throttle(lane, gap);
      try {
        const r = await fetch(url, { headers: { "User-Agent": UA_BROWSER, ...headers }, signal: AbortSignal.timeout(15000) });
        if (r.status === 429 || r.status >= 500) { err = new Error(host + " " + r.status); await sleep(Math.min(+r.headers.get("retry-after") * 1000 || 700 * 2 ** i, 6000)); continue; }
        if (!r.ok) throw Object.assign(new Error(host + " " + r.status), { final: true });
        const data = kind === "text" ? await r.text() : await r.json();
        if (cache.size > 300) cache.delete(cache.keys().next().value);
        cache.set(key, { data, exp: Date.now() + ttl });
        return data;
      } catch (e) { if (e.final) throw e; err = e; await sleep(500 * 2 ** i); }
    }
    throw err || new Error(host + " unreachable");
  })();
  pending.set(key, p);
  try { return await p; } finally { pending.delete(key); }
}

// ---------- title matching (used by the non-MangaDex providers, so a wrong series is never merged in) ----------
function sim(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.length >= 4 && l.includes(s) ? s.length / l.length : 0;
}
function bestMatch(cands, titles) {
  let best = null, top = 0;
  for (const c of cands) for (const n of c.names) for (const t of titles) { const v = sim(n, t); if (v > top) { top = v; best = c; } }
  return top >= 0.8 ? best : null;
}
// Original titles first, then cleaned variants (without "(...)" and without subtitles after ":" or " - ").
function variants(titles) {
  const out = [], add = t => { t = String(t || "").replace(/\s+/g, " ").trim(); if (t && !out.some(o => norm(o) === norm(t))) out.push(t); };
  const base = titles.filter(Boolean);
  base.forEach(add);
  base.forEach(t => { add(t.replace(/\(.*?\)/g, "")); add(t.split(/\s+[:\-–—]\s+|:\s+/)[0]); });
  return out.slice(0, 6);
}
async function searchEach(titles, n, fn) { // a failing search doesn't stop us trying the next title variant
  let lastErr = null, ok = false;
  for (const t of titles.slice(0, n)) { try { const hit = await fn(t); ok = true; if (hit) return hit; } catch (e) { lastErr = e; } }
  if (!ok && lastErr) throw lastErr;
  return null;
}

// ================= Provider 1: MangaDex (official API) =================
const MD = "https://api.mangadex.org";
const mdGet = (path, ttl) => get(MD + path, { ttl, gap: 220, lane: "md", tries: 4, headers: { "User-Agent": "tonedot/2.5", Accept: "application/json" } });

async function mdFind({ al, mal, titles }) {
  let fallback = null;
  for (const t of titles.slice(0, 4)) {
    const r = await mdGet("/manga?limit=10&title=" + encodeURIComponent(t) + "&availableTranslatedLanguage[]=en&order[relevance]=desc");
    const list = r.data || [];
    const byId = list.find(m => { const l = m.attributes.links || {}; return (al && l.al === String(al)) || (mal && l.mal === String(mal)); });
    if (byId) return { manga: byId, matched: "exact" };
    const byName = list.find(m => [m.attributes.title, ...(m.attributes.altTitles || [])].some(o => Object.values(o).some(x => norm(x) === norm(t))));
    if (byName) return { manga: byName, matched: "title" };
    fallback = fallback || list[0];
  }
  return fallback ? { manga: fallback, matched: "guess" } : null;
}

async function mdChapters(id) {
  const out = [];
  for (let offset = 0, total = 1; offset < total && offset < 10000; offset += 500) {
    const r = await mdGet(`/manga/${id}/feed?limit=500&offset=${offset}&translatedLanguage[]=en&order[volume]=asc&order[chapter]=asc&includes[]=scanlation_group&includeExternalUrl=0&includeEmptyPages=0&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica`);
    total = r.total || 0;
    out.push(...r.data);
  }
  const best = new Map();
  for (const c of out) {
    const a = c.attributes;
    if (a.externalUrl || !a.pages) continue;
    const key = a.chapter == null ? c.id : (a.volume || "") + "|" + a.chapter; // volume is part of the key, so restarted numbering isn't dropped
    const old = best.get(key);
    if (!old || a.pages > old.attributes.pages) best.set(key, c);
  }
  const rows = [...best.values()].map(c => ({
    ch: c.attributes.chapter, vol: c.attributes.volume, title: c.attributes.title, pages: c.attributes.pages,
    group: c.relationships.filter(x => x.type === "scanlation_group" && x.attributes).map(x => x.attributes.name).join(", "),
    ref: "mangadex:" + c.id
  }));
  const vn = v => (num(v.vol) == null ? 1e9 : num(v.vol));
  rows.sort((a, b) => vn(a) - vn(b) || (num(a.ch) ?? 1e9) - (num(b.ch) ?? 1e9));
  let season = 1, max = 0, seasons = false; // a drop back to chapter ~1 in a later volume means a new season
  rows.forEach(c => {
    const n = num(c.ch);
    if (n != null && c.vol && n <= 1.5 && max >= 10 && rows.some(x => x.vol && x.vol !== c.vol)) { season++; max = 0; seasons = true; }
    if (n != null) max = Math.max(max, n);
    c.s = season;
  });
  return { rows, seasons };
}

async function pMangaDex(ctx) {
  const f = await mdFind(ctx);
  if (!f) return null;
  const { rows, seasons } = await mdChapters(f.manga.id);
  const t = f.manga.attributes.title;
  return { matched: f.matched, title: t.en || Object.values(t)[0], mdId: f.manga.id, seasons, rows };
}

async function pagesMangaDex(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("bad MangaDex id");
  const s = await mdGet("/at-home/server/" + id, 60000), h = s.chapter.hash;
  return {
    urls: s.chapter.data.map(f => proxy(`${s.baseUrl}/data/${h}/${f}`)),
    alts: (s.chapter.dataSaver || []).map(f => proxy(`${s.baseUrl}/data-saver/${h}/${f}`)) // smaller copy, used if a full-size image fails
  };
}

// ================= Provider 2: Comick (JSON API) =================
const CK = "https://api.comick.fun";
const ckGet = (path, ttl) => get(CK + path, { ttl, gap: 300, lane: "ck", tries: 2, headers: { Accept: "application/json" } });

async function pComick({ titles }) {
  const found = await searchEach(titles, 3, async t => {
    const list = await ckGet("/v1.0/search?type=comic&limit=8&q=" + encodeURIComponent(t));
    const cands = (Array.isArray(list) ? list : []).map(c => ({ c, names: [c.title, c.slug && c.slug.replace(/-/g, " "), ...(c.md_titles || []).map(x => x.title)].filter(Boolean) }));
    const pick = bestMatch(cands, titles);
    return pick && pick.c;
  });
  if (!found) return null;
  const rows = []; let prevFirst = null;
  for (let page = 1; page <= 15; page++) {
    const r = await ckGet(`/comic/${found.hid}/chapters?lang=en&limit=300&page=${page}`);
    const list = r.chapters || [];
    if (!list.length || list[0].hid === prevFirst) break;
    prevFirst = list[0].hid;
    for (const c of list) rows.push({
      ch: c.chap, vol: c.vol, title: c.title, pages: null,
      group: Array.isArray(c.group_name) ? c.group_name.join(", ") : (c.group_name || ""), ref: "comick:" + c.hid
    });
    if (r.total != null && rows.length >= r.total) break;
  }
  return { matched: "title", title: found.title, rows };
}

async function pagesComick(hid) {
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(hid)) throw new Error("bad Comick id");
  const r = await ckGet(`/chapter/${hid}/get_images`, 600000);
  const urls = (Array.isArray(r) ? r : []).map(i => i.url || (i.b2key && "https://meo.comick.pictures/" + i.b2key)).filter(Boolean).map(proxy);
  return { urls, alts: [] };
}

// ================= Provider 3: Mangapill (HTML pages) =================
const PP = "https://mangapill.com";
const ppGet = (path, ttl) => get(PP + path, { kind: "text", ttl, gap: 300, lane: "pp", tries: 2, headers: { Accept: "text/html" } });
const strip = s => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

function ppSearch(html) {
  const map = new Map();
  for (const m of html.matchAll(/<a[^>]+href="(\/manga\/\d+\/[^"?#]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const e = map.get(m[1]) || { href: m[1], names: [m[1].split("/").pop().replace(/-/g, " ")] }; // the URL slug is a title too
    for (const d of m[2].matchAll(/<div[^>]*>([^<]{2,200})<\/div>/g)) { const t = strip(d[1]); if (t && !e.names.includes(t)) e.names.push(t); }
    map.set(m[1], e);
  }
  return [...map.values()];
}
function ppChapters(html) {
  const rows = [], seen = new Set();
  for (const m of html.matchAll(/<a[^>]+href="(\/chapters\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = m[1].replace(/&amp;/g, "&");
    let ch = (strip(m[2]).match(/chapter\s+(\d+(?:\.\d+)?)/i) || [])[1];
    if (ch == null) { const s = (href.match(/chapter-(\d+(?:-\d+)?)\/?$/i) || [])[1]; if (s) ch = s.replace("-", "."); }
    if (ch == null || seen.has(ch)) continue;
    seen.add(ch);
    rows.push({ ch, vol: null, title: null, pages: null, group: "Mangapill", ref: "mangapill:" + href });
  }
  return rows;
}
async function pMangapill({ titles }) {
  const found = await searchEach(titles, 3, async t => bestMatch(ppSearch(await ppGet("/search?q=" + encodeURIComponent(t))), titles));
  if (!found) return null;
  return { matched: "title", title: found.names[1] || found.names[0], rows: ppChapters(await ppGet(found.href)) };
}
async function pagesMangapill(path) {
  if (!/^\/chapters\/[A-Za-z0-9._~%+-]+(?:\/[A-Za-z0-9._~%+-]+)?$/.test(path)) throw new Error("bad Mangapill path");
  const html = await ppGet(path, 600000), urls = [];
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/js-page|readdetectiveconan/.test(m[0])) continue;
    const u = ((m[0].match(/data-src="([^"]+)"/) || m[0].match(/\ssrc="([^"]+)"/) || [])[1] || "").replace(/&amp;/g, "&");
    if (/^https?:/.test(u) && !urls.includes(u)) urls.push(u);
  }
  return { urls: urls.map(proxy), alts: [] };
}

// ================= Provider registry: add a new provider = add one entry here =================
const PROVIDERS = [
  { name: "MangaDex", key: "mangadex", run: pMangaDex, pages: pagesMangaDex },
  { name: "Comick", key: "comick", run: pComick, pages: pagesComick },
  { name: "Mangapill", key: "mangapill", run: pMangapill, pages: pagesMangapill }
];
const proxy = u => "/api/image?u=" + encodeURIComponent(u);

// Merge every provider's chapters into one list. A chapter missing on one provider is filled in from another.
function merge(results) {
  const live = results.filter(r => r.rows.length);
  if (!live.length) return { rows: [], seasons: false };
  // A MangaDex "guess" (no ID/title match) is only trusted when nobody else found the series.
  let base = live.length > 1 ? live.filter(r => !(r.name === "MangaDex" && r.matched === "guess")) : live;
  if (!base.length) base = live;
  const seasonal = base.find(r => r.seasons);
  if (seasonal) { // numbering restarts per season: other providers can't be lined up safely, so keep this one as-is
    return { seasons: true, rows: seasonal.rows.map(c => ({ ...c, src: [c.ref], via: [seasonal.name] })) };
  }
  const byKey = new Map();
  for (const r of base) for (const c of r.rows) {
    const n = num(c.ch), key = n == null ? "id:" + c.ref : "n:" + n;
    let e = byKey.get(key);
    if (!e) { e = { ch: c.ch, vol: c.vol, title: c.title, pages: c.pages, group: c.group, s: 1, src: [], via: [] }; byKey.set(key, e); }
    else { e.vol = e.vol || c.vol; e.title = e.title || c.title; e.pages = e.pages || c.pages; }
    if (!e.src.includes(c.ref)) { e.src.push(c.ref); e.via.push(r.name); }
  }
  const rows = [...byKey.values()].sort((a, b) => (num(a.ch) ?? 1e9) - (num(b.ch) ?? 1e9));
  return { rows, seasons: false };
}

async function getPages(refs) {
  let best = null; const errs = [];
  for (const ref of refs) {
    const i = ref.indexOf(":"), key = ref.slice(0, i), id = ref.slice(i + 1), p = PROVIDERS.find(x => x.key === key);
    if (!p) { errs.push("unknown source"); continue; }
    try {
      const r = await withTimeout(p.pages(id), 25000, p.name);
      const res = { provider: p.name, urls: r.urls, alts: r.alts || [] };
      if (r.urls.length >= 2) return res; // a 0 or 1 page result is probably broken: try the next source
      if (!best || r.urls.length > best.urls.length) best = res;
    } catch (e) { errs.push(p.name + ": " + e.message); }
  }
  if (best && best.urls.length) return best;
  throw new Error("Could not load pages. " + errs.join("; "));
}

export async function handleManga(url) {
  const q = Object.fromEntries(url.searchParams);
  try {
    if (q.action === "info") return json({ version: VERSION, providers: PROVIDERS.map(p => p.name) });
    if (q.action === "chapters") {
      const titles = variants([q.title, q.alt]);
      if (!titles.length) return json({ error: "title required" }, 400);
      const ctx = { al: q.al, mal: q.mal, titles };
      const results = await Promise.all(PROVIDERS.map(async p => {
        try {
          const r = await withTimeout(p.run(ctx), 40000, p.name);
          if (!r) return { name: p.name, rows: [], status: "not found" };
          return { name: p.name, ...r, status: r.rows.length ? "ok" : "no english chapters" };
        } catch (e) { return { name: p.name, rows: [], status: "error", error: e.message }; }
      }));
      const providers = results.map(r => ({ name: r.name, status: r.status, count: r.rows.length, matched: r.matched, title: r.title, error: r.error }));
      const m = merge(results);
      if (!m.rows.length) return json({ error: "No chapters found on any provider (" + providers.map(p => p.name + ": " + (p.error || p.status)).join(", ") + ")", providers }, 404);
      const md = results.find(r => r.name === "MangaDex" && r.mdId), top = results.find(r => r.rows.length);
      const flaky = results.some(r => r.status === "error"); // don't cache a result that was missing a provider because of an error
      return json({
        version: VERSION, mdId: md ? md.mdId : null, mdTitle: (md || top).title, matched: (md || top).matched, seasons: m.seasons, providers,
        chapters: m.rows.map(c => ({ id: c.src[0], src: c.src.slice(0, 6), via: c.via.slice(0, 6), ch: c.ch, vol: c.vol, title: c.title, pages: c.pages, group: c.group, s: c.s }))
      }, 200, { "Cache-Control": "public, max-age=" + (flaky ? 20 : 300) });
    }
    if (q.action === "pages") {
      const refs = (q.src || (q.id ? "mangadex:" + q.id : "")).split(",").map(s => s.trim()).filter(Boolean).slice(0, 6);
      if (!refs.length) return json({ error: "src required" }, 400);
      return json(await getPages(refs));
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e.message || "Could not reach manga providers" }, 502);
  }
}
export const handleMangadex = handleManga; // old name, kept so nothing that imports it breaks

// Image proxy for provider hosts only (not an open proxy). Adds the Referer each image host expects, streams, retries.
// If a provider ever changes its image CDN domain, add the new host here.
function imageReferer(h) {
  if (h.endsWith(".mangadex.network") || h.endsWith(".mangadex.org")) return "";
  if (h === "comick.pictures" || h.endsWith(".comick.pictures") || h.endsWith(".comick.fun") || h.endsWith(".comick.io")) return "https://comick.io/";
  if (h === "readdetectiveconan.com" || h.endsWith(".readdetectiveconan.com")) return "https://mangapill.com/";
  return null;
}
export async function handleImage(url) {
  let u;
  try { u = new URL(String(url.searchParams.get("u"))); } catch { return new Response(null, { status: 400 }); }
  const ref = u.protocol === "https:" ? imageReferer(u.hostname) : null;
  if (ref === null) return new Response(null, { status: 400 });
  const headers = { "User-Agent": ref ? UA_BROWSER : "tonedot/2.5", Accept: "image/*,*/*;q=0.8" };
  if (ref) headers.Referer = ref;
  let status = 502;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u, { headers });
      if (r.ok) return new Response(r.body, { headers: { "Content-Type": r.headers.get("content-type") || "image/jpeg", "Cache-Control": "public, max-age=604800, immutable" } });
      status = r.status;
      if (r.status < 500 && r.status !== 429) break;
    } catch { status = 502; }
    await sleep(400 * 2 ** i);
  }
  return new Response(null, { status });
}
